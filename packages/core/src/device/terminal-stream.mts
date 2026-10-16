// 一个终端的输出，从进来到交给界面的这一段：留着末尾的一段，按各个界面处理得过来的速度往外交。
// 真的核心和模拟核心用的是同一份。
//
// 伪终端的输出很碎，一秒可以有上万块；界面那头的终端控件解析、排版都要时间。这里做三件事：
// - 合并：连着来的输出攒一小会儿，并成一条增量再交（歇过之后来的第一块不等，敲一个键的回显不因此变慢）；
// - 限量：交给一个界面、它还没回报处理完的，到了一个量就不再给它，等它回报（terminal.ack）。
//   所以界面那头永远只压着有限的一点，主线程不会被堵死；
// - 只留末尾：没交出去的输出留在一个按字节数封顶的缓冲里，超了丢最早的。落后太多的界面少掉中间一段，
//   少掉的地方有记号（mark），界面在那里说一声。内存不随输出的多少涨。
//
// 输出的位置用字节偏移表示。属于设备的终端，偏移就是设备报的那个（从进程启动算起）；
// 随连接结束的终端，偏移是这里自己数的。
import type { Clock } from '../channel/protocol.mjs'
import type {
  TerminalHave,
  TerminalMark,
  TerminalOp,
  TerminalStreamView,
} from '../model-terminal.mjs'

export interface StreamSink {
  snapshot(data: TerminalStreamView): void
  delta(ops: TerminalOp[]): void
}

export interface StreamLimits {
  /** 留多少输出，字节。落后超过它的界面会少一段 */
  ringBytes: number
  /** 交给一个界面、它还没回报处理完的，最多这么多字节 */
  windowBytes: number
  /** 一条增量最多带这么多字节 */
  batchBytes: number
  /** 连着来的输出隔这么久交一次，毫秒 */
  flushMs: number
}

export const STREAM_LIMITS: StreamLimits = {
  ringBytes: 1024 * 1024,
  windowBytes: 256 * 1024,
  batchBytes: 96 * 1024,
  flushMs: 8,
}

type Entry =
  | { kind: 'data'; from: number; bytes: number; data: string }
  | { kind: 'mark'; at: number; mark: TerminalMark }

const startOf = (entry: Entry): number => (entry.kind === 'data' ? entry.from : entry.at)
const endOf = (entry: Entry): number =>
  entry.kind === 'data' ? entry.from + entry.bytes : entry.at + entry.mark.missed

interface Viewer {
  id: number
  sink: StreamSink
  /** 下一个要给它的偏移 */
  cursor: number
  /** 下一个要给它的是缓冲里的第几条（从这条流开始算起的序号，不是数组下标） */
  next: number
  /** 交出去了、它还没回报处理完的数据有多少字节 */
  inflight: number
  /** 交出去的每一条：到哪个偏移为止、多少字节。它回报到哪，就把那之前的勾掉 */
  sent: { to: number; bytes: number }[]
}

export interface StreamOptions {
  clock: Clock
  limits?: StreamLimits
  /** 还不知道从哪个偏移开始（从设备上恢复的终端，要等第一次挂上）。这期间来订阅的先等着 */
  pending?: boolean
  /** 积压的多少、有没有人看变了：上层据此决定要不要让设备先别发、或者接着发 */
  changed?(): void
}

export class TerminalStream {
  readonly #clock: Clock
  readonly #limits: StreamLimits
  readonly #changed: (() => void) | undefined
  #epoch = 0
  #entries: Entry[] = []
  /** 缓冲里第一条在数组里的位置：丢最早的时候只往后挪，隔一阵再真的截掉 */
  #first = 0
  /** 数组里第 0 条的序号 */
  #base = 0
  /** 缓冲里的数据一共多少字节 */
  #kept = 0
  #head = 0
  #ready: boolean
  readonly #viewers = new Map<number, Viewer>()
  /** 还不知道从哪开始的时候来订阅的 */
  readonly #waiting = new Map<number, { sink: StreamSink; have: TerminalHave | undefined }>()
  #nextViewer = 1
  #stopTimer: (() => void) | null = null
  #lastPump = Number.NEGATIVE_INFINITY
  /** 没人看的时候，从这个偏移起的输出都没人消费过 */
  #idleFrom = 0

  constructor(options: StreamOptions) {
    this.#clock = options.clock
    this.#limits = options.limits ?? STREAM_LIMITS
    this.#changed = options.changed
    this.#ready = options.pending !== true
  }

  get epoch(): number {
    return this.#epoch
  }

  /** 到现在为止一共收到哪个偏移 */
  get head(): number {
    return this.#head
  }

  /** 缓冲里最早的那个字节的偏移 */
  get start(): number {
    const entry = this.#entries[this.#first]
    return entry ? startOf(entry) : this.#head
  }

  get ready(): boolean {
    return this.#ready
  }

  get viewers(): number {
    return this.#viewers.size + this.#waiting.size
  }

  /**
   * 最慢的那个界面还有多少没拿走。没人看的时候，是从最后一个界面走掉算起又来了多少。
   * 这个数一直涨，说明输出没人消费：再收也只是把缓冲里旧的顶掉
   */
  lag(): number {
    if (this.#viewers.size === 0) return this.#head - this.#idleFrom
    let slowest = this.#head
    for (const viewer of this.#viewers.values()) slowest = Math.min(slowest, viewer.cursor)
    return this.#head - slowest
  }

  /** 有没有哪个界面已经把缓冲里的都拿走了，而且手上压着的不多：这时候再来输出它收得下 */
  caughtUp(): boolean {
    const end = this.#base + this.#entries.length
    for (const viewer of this.#viewers.values()) {
      if (viewer.next >= end && viewer.inflight <= this.#limits.windowBytes / 2) return true
    }
    return false
  }

  /** 一块新的输出，接在已有的后面 */
  push(data: string, bytes: number): void {
    if (bytes <= 0) return
    this.#entries.push({ kind: 'data', from: this.#head, bytes, data })
    this.#head += bytes
    this.#kept += bytes
    this.#trim()
    this.#schedule()
  }

  /** 输出在这里不连续（少了 mark.missed 字节），或者有一件要让人看见的事 */
  mark(mark: TerminalMark): void {
    this.#entries.push({ kind: 'mark', at: this.#head, mark })
    this.#head += mark.missed
    this.#schedule()
  }

  /** 知道从哪个偏移开始了：等着的订阅这时才拿到快照。只在缓冲还空着的时候有意义 */
  begin(offset: number): void {
    if (this.#ready) return
    this.#ready = true
    this.#head = offset
    this.#idleFrom = offset
    const waiting = [...this.#waiting]
    this.#waiting.clear()
    for (const [id, entry] of waiting) this.#admit(id, entry.sink, entry.have)
    this.#changed?.()
  }

  /** 进程在同一个标签里重开了：之前的输出不要了，偏移从头算，订阅着的界面各自清屏 */
  reset(): void {
    this.#epoch++
    this.#base += this.#entries.length
    this.#entries = []
    this.#first = 0
    this.#kept = 0
    this.#head = 0
    this.#idleFrom = 0
    this.#ready = true
    for (const viewer of this.#viewers.values()) {
      viewer.cursor = 0
      viewer.next = this.#base
      viewer.inflight = 0
      viewer.sent = []
      viewer.sink.delta([{ op: 'reset', epoch: this.#epoch }])
    }
    const waiting = [...this.#waiting]
    this.#waiting.clear()
    for (const [id, entry] of waiting) this.#admit(id, entry.sink, undefined)
  }

  /** 一个界面来订阅。先给快照（说从哪开始），字节随后走增量。返回退订函数 */
  attach(sink: StreamSink, have?: TerminalHave): () => void {
    const id = this.#nextViewer++
    if (this.#ready) this.#admit(id, sink, have)
    else this.#waiting.set(id, { sink, have })
    this.#changed?.()
    return () => {
      this.#waiting.delete(id)
      if (this.#viewers.delete(id) && this.#viewers.size === 0) this.#idleFrom = this.#head
      this.#changed?.()
    }
  }

  /** 界面回报：这次订阅已经处理到 offset 了 */
  ack(viewerId: number, epoch: number, offset: number): void {
    const viewer = this.#viewers.get(viewerId)
    if (!viewer || epoch !== this.#epoch) return
    let settled = 0
    while (settled < viewer.sent.length && (viewer.sent[settled]?.to ?? 0) <= offset) {
      viewer.inflight -= viewer.sent[settled]?.bytes ?? 0
      settled++
    }
    if (settled === 0) return
    viewer.sent.splice(0, settled)
    this.#pump(viewer)
    this.#changed?.()
  }

  /** 不再用了：定时器停掉 */
  dispose(): void {
    this.#stopTimer?.()
    this.#stopTimer = null
    this.#viewers.clear()
    this.#waiting.clear()
  }

  #admit(id: number, sink: StreamSink, have: TerminalHave | undefined): void {
    let cursor = this.start
    let next = this.#base + this.#first
    let missed = 0
    let truncated = cursor > 0
    // 界面手里的是这同一条流上的：只补后面的。它的位置比这里的还靠后，说明不是这条流的，当它什么都没有
    if (have && have.epoch === this.#epoch && have.offset <= this.#head) {
      truncated = false
      if (have.offset < cursor) missed = cursor - have.offset
      else {
        // 交出去的都是整块，界面的位置应当正好在某一块的开头；万一落在一块中间，从下一块起，中间的算少了
        const at = this.#locate(have.offset)
        const entry = this.#entries[at]
        cursor = entry ? startOf(entry) : this.#head
        next = this.#base + at
        missed = cursor - have.offset
      }
    }
    const viewer: Viewer = { id, sink, cursor, next, inflight: 0, sent: [] }
    this.#viewers.set(id, viewer)
    sink.snapshot({ viewer: id, epoch: this.#epoch, from: cursor, missed, truncated })
    this.#pump(viewer)
  }

  /** 超了就丢最早的 */
  #trim(): void {
    const { ringBytes } = this.#limits
    while (this.#kept > ringBytes && this.#entries.length - this.#first > 1) {
      const entry = this.#entries[this.#first]
      if (entry?.kind === 'data') this.#kept -= entry.bytes
      this.#first++
    }
    // 开头剩下的记号跟着丢：落后到这里的界面反正会得到一个“少了一段”的记号
    while (this.#entries[this.#first]?.kind === 'mark' && this.#entries.length - this.#first > 1) {
      this.#first++
    }
    if (this.#first > 512 && this.#first > this.#entries.length / 2) {
      this.#entries = this.#entries.slice(this.#first)
      this.#base += this.#first
      this.#first = 0
    }
  }

  #schedule(): void {
    if (this.#stopTimer) return
    const wait = this.#limits.flushMs - (this.#clock.now() - this.#lastPump)
    if (wait <= 0) {
      this.#pumpAll()
      return
    }
    this.#stopTimer = this.#clock.setTimer(() => {
      this.#stopTimer = null
      this.#pumpAll()
    }, wait)
  }

  #pumpAll(): void {
    this.#lastPump = this.#clock.now()
    for (const viewer of this.#viewers.values()) this.#pump(viewer)
    this.#changed?.()
  }

  /** 把缓冲里它还没拿的交给它，到它手上压着的量为止 */
  #pump(viewer: Viewer): void {
    const { windowBytes, batchBytes } = this.#limits
    // 它手上压满了：什么都不给，连“少了一段”的记号也等它腾出手再算，不然每来一块输出就多一个小记号
    if (viewer.inflight >= windowBytes) return
    const ops: TerminalOp[] = []
    let at = viewer.next - this.#base
    if (at < this.#first) {
      // 它落后到缓冲外面去了：中间那段已经没有了
      const start = this.start
      if (start > viewer.cursor) {
        ops.push({
          op: 'mark',
          at: viewer.cursor,
          mark: { kind: 'backlog', missed: start - viewer.cursor },
        })
        viewer.cursor = start
      }
      at = this.#first
    }
    while (at < this.#entries.length && viewer.inflight < windowBytes) {
      const entry = this.#entries[at]
      if (!entry) break
      if (entry.kind === 'mark') {
        ops.push({ op: 'mark', at: entry.at, mark: entry.mark })
        viewer.cursor = endOf(entry)
        at++
        continue
      }
      const chunks: string[] = []
      const from = entry.from
      let bytes = 0
      for (; at < this.#entries.length && bytes < batchBytes; at++) {
        const next = this.#entries[at]
        if (next?.kind !== 'data') break
        chunks.push(next.data)
        bytes += next.bytes
      }
      ops.push({ op: 'output', from, to: from + bytes, chunks })
      viewer.cursor = from + bytes
      viewer.inflight += bytes
      viewer.sent.push({ to: viewer.cursor, bytes })
    }
    viewer.next = this.#base + at
    if (ops.length > 0) viewer.sink.delta(ops)
  }

  /** 开头不早于这个偏移的第一条在数组里的位置；没有就是数组的长度 */
  #locate(offset: number): number {
    let low = this.#first
    let high = this.#entries.length
    while (low < high) {
      const middle = (low + high) >> 1
      const entry = this.#entries[middle]
      if (entry && startOf(entry) < offset) low = middle + 1
      else high = middle
    }
    return low
  }
}
