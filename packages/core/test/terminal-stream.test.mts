// 终端输出从核心到界面的这一段（packages/core/src/device/terminal-stream.mts）：合并、限量、只留末尾、续订。
// 直接对着这个类测，量都调得很小。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  base64Bytes,
  decodeBase64,
  decodeUtf8,
  type StreamLimits,
  type TerminalMark,
  type TerminalOp,
  TerminalStream,
  type TerminalStreamView,
  textToBase64,
} from '../src/index.mjs'
import { dropBase64Head } from '../src/text/bytes.mjs'
import { fakeClock } from './helpers.mjs'

const LIMITS: StreamLimits = { ringBytes: 100, windowBytes: 40, batchBytes: 16, flushMs: 8 }

function setup(options: { pending?: boolean } = {}) {
  const time = fakeClock()
  let changes = 0
  const stream = new TerminalStream({
    clock: time.clock,
    limits: LIMITS,
    changed: () => changes++,
    ...options,
  })
  /** 出 count 块，每块 size 字节，块与块之间隔够久（各自马上交） */
  const pour = (count: number, size = 10, letter = 'a') => {
    for (let at = 0; at < count; at++) {
      time.advance(LIMITS.flushMs)
      stream.push(textToBase64(letter.repeat(size)), size)
    }
  }
  return { stream, time, pour, changes: () => changes }
}

/** 一个界面：把快照和增量落下来 */
function viewer(stream: TerminalStream, have?: { epoch: number; offset: number }) {
  const state = {
    view: null as TerminalStreamView | null,
    text: '',
    bytes: 0,
    offset: 0,
    marks: [] as { at: number; mark: TerminalMark }[],
    ops: [] as TerminalOp[],
    resets: 0,
  }
  const close = stream.attach(
    {
      snapshot(data) {
        state.view = data
        state.offset = data.from
      },
      delta(ops) {
        for (const op of ops) {
          state.ops.push(op)
          if (op.op === 'output') {
            assert.equal(op.from, state.offset, '增量接着上一条')
            for (const chunk of op.chunks) state.text += decodeUtf8(decodeBase64(chunk))
            state.bytes += op.to - op.from
            state.offset = op.to
          } else if (op.op === 'mark') {
            state.marks.push({ at: op.at, mark: op.mark })
            state.offset = op.at + op.mark.missed
          } else {
            state.resets++
            state.offset = 0
            state.text = ''
          }
        }
      },
    },
    have,
  )
  const ack = (epoch = stream.epoch) => stream.ack(state.view?.viewer ?? 0, epoch, state.offset)
  return { state, close, ack }
}

test('限量：界面没回报处理完之前只给到压得住的量，回报了才接着给', () => {
  const { stream, pour } = setup()
  const ui = viewer(stream)
  assert.deepEqual(ui.state.view, { viewer: 1, epoch: 0, from: 0, missed: 0, truncated: false })
  pour(8)
  assert.equal(ui.state.bytes, 40)
  assert.equal(stream.lag(), 40)
  assert.equal(stream.caughtUp(), false)
  ui.ack()
  assert.equal(ui.state.bytes, 80)
  // 缓冲里的都拿走了，但手上压着的还多：还不算追上
  assert.equal(stream.lag(), 0)
  assert.equal(stream.caughtUp(), false)
  ui.ack()
  assert.equal(stream.caughtUp(), true)
  assert.equal(ui.state.text, 'a'.repeat(80))
})

test('合并：连着来的并成一条再交，一条不超过规定的量；歇过之后的第一块不等', () => {
  const { stream, time } = setup()
  const ui = viewer(stream)
  stream.push(textToBase64('k'), 1)
  assert.equal(ui.state.ops.length, 1, '第一块马上交')
  for (let at = 0; at < 5; at++) stream.push(textToBase64('abcdef'), 6)
  assert.equal(ui.state.ops.length, 1, '紧跟着的先攒着')
  time.advance(LIMITS.flushMs)
  // 30 个字节：一条最多带到过 16 字节为止，所以是 18 加 12
  assert.deepEqual(
    ui.state.ops
      .slice(1)
      .map((op) => (op.op === 'output' ? [op.from, op.to, op.chunks.length] : op)),
    [
      [1, 19, 3],
      [19, 31, 2],
    ],
  )
})

test('只留末尾：落后到缓冲外面的界面少一段，少了多少有记号，内存不跟着涨', () => {
  const { stream, pour } = setup()
  const ui = viewer(stream)
  pour(4, 10, 'a')
  pour(26, 10, 'b')
  assert.equal(ui.state.bytes, 40)
  assert.equal(stream.head, 300)
  assert.equal(stream.start, 200, '缓冲只留末尾 100 字节')
  ui.ack()
  ui.ack()
  ui.ack()
  ui.ack()
  assert.deepEqual(ui.state.marks, [{ at: 40, mark: { kind: 'backlog', missed: 160 } }])
  assert.equal(ui.state.text, 'a'.repeat(40) + 'b'.repeat(100))
  assert.equal(ui.state.offset, 300)
})

test('续订：带着手里的位置来，只补后面的；位置比缓冲还早就说少了多少；不是这条流的当作什么都没有', () => {
  const { stream, pour } = setup()
  pour(30)
  const near = viewer(stream, { epoch: 0, offset: 250 })
  assert.deepEqual(near.state.view, { viewer: 1, epoch: 0, from: 250, missed: 0, truncated: false })
  near.ack()
  near.ack()
  assert.equal(near.state.bytes, 50)

  const far = viewer(stream, { epoch: 0, offset: 50 })
  assert.deepEqual(far.state.view, {
    viewer: 2,
    epoch: 0,
    from: 200,
    missed: 150,
    truncated: false,
  })

  // 手里的是另一次进程的（重开过），或者比这里的还靠后：从缓冲的开头给，并说明前面还有
  const stale = viewer(stream, { epoch: 3, offset: 250 })
  assert.deepEqual(stale.state.view, { viewer: 3, epoch: 0, from: 200, missed: 0, truncated: true })
  const ahead = viewer(stream, { epoch: 0, offset: 999 })
  assert.deepEqual(ahead.state.view, { viewer: 4, epoch: 0, from: 200, missed: 0, truncated: true })

  // 没带位置的新订阅也一样
  const fresh = viewer(stream)
  assert.deepEqual(fresh.state.view, { viewer: 5, epoch: 0, from: 200, missed: 0, truncated: true })
})

test('记号：不占字节的记号也照样送到，每个只送一次，先后不乱', () => {
  const { stream, time } = setup()
  const ui = viewer(stream)
  stream.push(textToBase64('ab'), 2)
  stream.mark({ kind: 'rejoined', missed: 0, replayed: 0 })
  time.advance(LIMITS.flushMs)
  stream.push(textToBase64('cd'), 2)
  stream.mark({ kind: 'backlog', missed: 5 })
  stream.mark({ kind: 'rejoined', missed: 0, replayed: 3 })
  time.advance(LIMITS.flushMs)
  ui.ack()
  time.advance(LIMITS.flushMs)
  assert.deepEqual(ui.state.marks, [
    { at: 2, mark: { kind: 'rejoined', missed: 0, replayed: 0 } },
    { at: 4, mark: { kind: 'backlog', missed: 5 } },
    { at: 9, mark: { kind: 'rejoined', missed: 0, replayed: 3 } },
  ])
  assert.equal(ui.state.text, 'abcd')
  assert.equal(stream.head, 9)
  assert.equal(stream.caughtUp(), true)
})

test('重开：偏移从头算，订阅着的界面收到清屏，旧的回报不算数', () => {
  const { stream, pour } = setup()
  const ui = viewer(stream)
  pour(6)
  assert.equal(ui.state.bytes, 40)
  stream.reset()
  assert.deepEqual([stream.epoch, stream.head, ui.state.resets, ui.state.offset], [1, 0, 1, 0])
  pour(6, 10, 'n')
  assert.equal(ui.state.text, 'n'.repeat(40))
  // 上一次进程的回报：不该把这一次压着的勾掉
  stream.ack(1, 0, 40)
  assert.equal(ui.state.text, 'n'.repeat(40))
  ui.ack()
  assert.equal(ui.state.text, 'n'.repeat(60))
})

test('从设备上恢复的终端：知道从哪个偏移开始之前，来订阅的先等着', () => {
  const { stream, changes } = setup({ pending: true })
  const ui = viewer(stream)
  assert.equal(ui.state.view, null)
  assert.equal(stream.viewers, 1, '等着的也算有人在看')
  const before = changes()
  stream.begin(500)
  assert.ok(changes() > before)
  assert.deepEqual(ui.state.view, { viewer: 1, epoch: 0, from: 500, missed: 0, truncated: true })
  stream.push(textToBase64('hi'), 2)
  assert.deepEqual(ui.state.ops, [
    { op: 'output', from: 500, to: 502, chunks: [textToBase64('hi')] },
  ])
})

test('没人看的时候：积压从最后一个界面走掉算起', () => {
  const { stream, pour } = setup()
  pour(5)
  assert.equal(stream.lag(), 50)
  const ui = viewer(stream)
  ui.close()
  assert.equal(stream.lag(), 0)
  pour(3)
  assert.equal(stream.lag(), 30)
  assert.equal(stream.caughtUp(), false)
})

test('字节工具：不解码也数得出字节数；从 base64 的开头去掉若干字节', () => {
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', '中文和 emoji 🙂']) {
    const encoded = textToBase64(text)
    const bytes = decodeBase64(encoded)
    assert.equal(base64Bytes(encoded), bytes.length)
    assert.equal(decodeUtf8(bytes), text)
    for (let skip = 0; skip <= bytes.length; skip++) {
      assert.deepEqual(decodeBase64(dropBase64Head(encoded, skip)), bytes.subarray(skip))
    }
  }
})
