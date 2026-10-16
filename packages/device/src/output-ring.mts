// 一个进程末尾一段输出的缓冲：按字节算上限，超了从头丢。两路输出（stdout、stderr）按到来的先后
// 排在同一条序列里，位置用字节偏移表示：从进程启动算起，两路合在一起数。
// 挂着的连接各自记着“发到哪了”，所以它同时也是给落后的连接补发用的队列。

export type OutputStream = 'stdout' | 'stderr'

interface Chunk {
  /** 这一块第一个字节的偏移 */
  offset: number
  stream: OutputStream
  data: Buffer
  /** 这一路输出到这一块为止触达了上限（协议里的 capReached） */
  cap: boolean
}

export interface OutputPiece {
  stream: OutputStream
  data: Buffer
  capReached: boolean
}

/** 存进来的块超过这么大就切开：从头丢的时候，丢掉的部分才真的把内存还回去 */
const PIECE_BYTES = 64 * 1024

/**
 * 小于这个数的 Buffer 可能是从 Node 的公共池里切出来的，留着它会把整块池子拖住不放：
 * 存之前抄一份自己的。
 */
const POOLED_BELOW = Buffer.poolSize >>> 1

/** 丢掉的块在数组里攒到这么多个、并且占了一半以上，才真的从数组里删 */
const COMPACT_AT = 1024

const NOTHING = Buffer.alloc(0)

export class OutputRing {
  private readonly capacity: number
  private chunks: Chunk[] = []
  /**
   * chunks 里这个下标之前的块已经丢了。伪终端的输出很碎，缓冲配得大的时候数组里有几万块，
   * 每丢一块都把整个数组往前搬一遍太慢，所以先记着，攒多了再一起删。
   */
  private head = 0
  /** 留着的第一个字节的偏移 */
  from = 0
  /** 到现在为止的总字节数，也就是下一个字节的偏移 */
  to = 0

  constructor(capacity: number) {
    this.capacity = capacity
  }

  push(stream: OutputStream, data: Buffer, cap: boolean): void {
    for (let start = 0; start < data.length; start += PIECE_BYTES) {
      const end = Math.min(data.length, start + PIECE_BYTES)
      const whole = start === 0 && end === data.length
      let own = data
      if (!whole || data.length < POOLED_BELOW) {
        // allocUnsafeSlow 不走公共池
        own = Buffer.allocUnsafeSlow(end - start)
        data.copy(own, 0, start, end)
      }
      this.chunks.push({ offset: this.to, stream, data: own, cap: cap && end === data.length })
      this.to += end - start
    }
  }

  /**
   * 把超出上限的开头丢掉，但不越过 floor：挂着的连接里跑得最快的那条还没拿到的不丢
   * （这时候进程已经被按住不读了，多出来的只是按住之前在路上的那一点）。
   */
  trim(floor: number): void {
    const target = Math.min(this.to - this.capacity, floor)
    if (target <= this.from) return
    const { chunks } = this
    let head = this.head
    for (; head < chunks.length; head++) {
      const chunk = chunks[head] as Chunk
      if (chunk.offset + chunk.data.length > target) break
      // 数据现在就放手，数组里的位置攒多了再一起删
      chunk.data = NOTHING
    }
    const first = chunks[head]
    if (first && first.offset < target) {
      first.data = first.data.subarray(target - first.offset)
      first.offset = target
    }
    if (head >= COMPACT_AT && head * 2 >= chunks.length) {
      this.chunks = chunks.slice(head)
      head = 0
    }
    this.head = head
    this.from = target
  }

  /**
   * 从偏移 from 起取一段：只取同一路输出的，不越过 limit，不超过 max 字节。
   * 相邻的小块并成一片（伪终端的输出很碎）。没有可取的返回 null。
   */
  read(from: number, limit: number, max: number): OutputPiece | null {
    const end = Math.min(limit, this.to)
    if (from < this.from || from >= end) return null
    let index = this.locate(from)
    const stream = (this.chunks[index] as Chunk).stream
    const parts: Buffer[] = []
    let size = 0
    let at = from
    let capReached = false
    while (index < this.chunks.length && size < max && at < end) {
      const chunk = this.chunks[index] as Chunk
      if (chunk.stream !== stream) break
      const start = at - chunk.offset
      const take = Math.min(chunk.data.length - start, max - size, end - at)
      parts.push(take === chunk.data.length ? chunk.data : chunk.data.subarray(start, start + take))
      size += take
      at += take
      // 这一块没取完，或者这一路到这里触达了上限：到此为止
      if (start + take < chunk.data.length) break
      if (chunk.cap) {
        capReached = true
        break
      }
      index++
    }
    const data = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, size)
    return { stream, data, capReached }
  }

  /** 包含这个偏移的那一块的下标。调用之前已经确认偏移在留着的范围里 */
  private locate(offset: number): number {
    let low = this.head
    let high = this.chunks.length - 1
    while (low < high) {
      const middle = (low + high + 1) >>> 1
      if ((this.chunks[middle] as Chunk).offset <= offset) low = middle
      else high = middle - 1
    }
    return low
  }
}
