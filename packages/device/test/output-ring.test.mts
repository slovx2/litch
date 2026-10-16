// 进程输出的缓冲：拿一个最笨的写法（每个字节记一笔）对着它随机地存、裁、取，两边要一直一样。
import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputRing, type OutputStream } from '../src/output-ring.mjs'

/** 固定种子的随机数：失败了能照原样再来一遍 */
function random(seed: number): (below: number) => number {
  let state = seed
  return (below) => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296) * below)
  }
}

/** 最笨的写法：全部字节都留着，哪些还算“留着的”只记一个起点 */
class Model {
  readonly bytes: number[] = []
  readonly streams: OutputStream[] = []
  /** 触达上限的那一块结束的位置 */
  readonly capEnds = new Set<number>()
  from = 0
  private readonly capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get to(): number {
    return this.bytes.length
  }

  push(stream: OutputStream, data: Buffer, cap: boolean): void {
    for (const byte of data) {
      this.bytes.push(byte)
      this.streams.push(stream)
    }
    if (cap && data.length) this.capEnds.add(this.to)
  }

  trim(floor: number): void {
    this.from = Math.max(this.from, Math.min(this.to - this.capacity, floor))
  }

  read(from: number, limit: number, max: number) {
    const end = Math.min(limit, this.to)
    if (from < this.from || from >= end) return null
    const stream = this.streams[from] as OutputStream
    let at = from
    let capReached = false
    while (at < end && at - from < max && this.streams[at] === stream) {
      at++
      if (this.capEnds.has(at)) {
        capReached = true
        break
      }
    }
    return { stream, data: Buffer.from(this.bytes.slice(from, at)), capReached }
  }
}

function exercise(seed: number, capacity: number, steps: number, large: boolean): void {
  const pick = random(seed)
  const ring = new OutputRing(capacity)
  const model = new Model(capacity)
  for (let step = 0; step < steps; step++) {
    // 大多数是伪终端那样的碎块，偶尔来一块比一帧还大的
    const size = large && pick(200) === 0 ? 60_000 + pick(150_000) : pick(40)
    const data = Buffer.alloc(size)
    // 每一块的内容都不一样，位置错了一个字节也对不上
    const salt = pick(256)
    for (let index = 0; index < size; index++) data[index] = (index * 31 + salt) & 255
    const stream: OutputStream = pick(8) === 0 ? 'stderr' : 'stdout'
    const cap = pick(50) === 0
    ring.push(stream, data, cap)
    model.push(stream, data, cap)
    if (pick(3) !== 0) {
      // 有时没人挂着（只留末尾），有时最快的那条落在后面
      const floor = pick(4) === 0 ? Math.max(0, model.to - pick(3 * capacity)) : model.to
      ring.trim(floor)
      model.trim(floor)
    }
    assert.deepEqual([ring.from, ring.to], [model.from, model.to], `第 ${step} 步之后的范围`)
    for (let reads = 0; reads < 3; reads++) {
      const span = model.to - model.from
      const from = model.from + pick(span + 3) - 1
      const limit = pick(5) === 0 ? from + pick(span + 2) : model.to + pick(2)
      const max = 1 + pick(pick(2) === 0 ? 64 : 70_000)
      const [got, want] = [ring.read(from, limit, max), model.read(from, limit, max)]
      if (!want) {
        assert.equal(got, null, `第 ${step} 步：${from} 起到 ${limit} 没有可取的`)
        continue
      }
      assert.ok(got, `第 ${step} 步：${from} 起到 ${limit} 应该取得到`)
      assert.deepEqual(
        [got.stream, got.capReached, got.data.length],
        [want.stream, want.capReached, want.data.length],
        `第 ${step} 步：${from} 起到 ${limit}，最多 ${max}`,
      )
      assert.ok(got.data.equals(want.data), `第 ${step} 步：${from} 起的内容`)
    }
  }
}

test('碎块很多：丢掉的块攒起来再删，范围和取出来的内容一直和逐字节的写法一样', () => {
  // 上限小、块又碎：从头丢的次数远多于“攒够了才删”的那个数
  exercise(1, 3000, 12_000, false)
  exercise(2, 64, 6000, false)
})

test('夹着比一帧还大的块：切开存，裁到块中间，取的时候跨块拼', () => {
  exercise(3, 100_000, 1200, true)
  exercise(4, 5000, 1200, true)
})

test('从头读到尾，一段接一段：拼起来就是存进去的', () => {
  const pick = random(5)
  const ring = new OutputRing(1 << 20)
  const stored: Buffer[] = []
  for (let index = 0; index < 4000; index++) {
    const data = Buffer.from(`${index}:${'x'.repeat(pick(30))}\n`)
    stored.push(data)
    ring.push('stdout', data, false)
  }
  const parts: Buffer[] = []
  let cursor = 0
  for (;;) {
    const piece = ring.read(cursor, ring.to, 4096)
    if (!piece) break
    assert.ok(piece.data.length <= 4096)
    parts.push(piece.data)
    cursor += piece.data.length
  }
  assert.equal(cursor, ring.to)
  assert.ok(Buffer.concat(parts).equals(Buffer.concat(stored)))
})
