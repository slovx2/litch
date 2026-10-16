// 通道上只留头尾的一大段（text/output-cap.mts 的 skipOutput、extendSkipping、appendSkipping）：
// 不管接在什么样的输出后面、一帧里怎么分段来的，收的一方接出来都和把整段接上去一模一样。
// 这里用通道真的那个队列（channel/server.mts 的 createOpQueue）按帧并增量，再逐帧对照。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendOutput,
  appendSkipping,
  type CappedOutput,
  createOpQueue,
  OUTPUT_KEEP,
  type SessionOp,
  SKIP_AT,
  skipOutput,
} from '../src/index.mjs'

const EMPTY: CappedOutput = { output: '', elided: null }

/** 可以重放的伪随机数：分段的方式每次一样，失败了能复现 */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** 几种输出：一行一行的日志、没有换行的一长串、中文加代理对、换行很稀的 */
function sample(kind: number, size: number, next: () => number): string {
  const pieces = ['ok ', '编译', '😀', 'x'.repeat(40), '\n', '…', 'é']
  let text = ''
  while (text.length < size) {
    if (kind === 0) text += `[${text.length}] building module … ok\n`
    else if (kind === 1) text += 'abcdefghij'.repeat(50)
    else if (kind === 2) text += pieces[Math.floor(next() * pieces.length)] ?? ''
    else text += next() < 0.002 ? '\n' : (pieces[Math.floor(next() * 4)] ?? '')
  }
  return text
}

/** 按通道的做法一帧一帧地并，收的一方按收到的增量接；每一帧之后和整段接的对照 */
function replay(text: string, seed: number, perFrame: number, maxDelta: number) {
  const next = random(seed)
  const queue = createOpQueue()
  let full = EMPTY
  let seen = EMPTY
  let skipped = 0
  let frames = 0
  for (let at = 0; at < text.length; ) {
    const count = 1 + Math.floor(next() * perFrame)
    for (let index = 0; index < count && at < text.length; index++) {
      const size = 1 + Math.floor(next() * maxDelta)
      const delta = text.slice(at, at + size)
      at += size
      full = appendOutput(full, delta)
      queue.push([{ op: 'item.appendText', itemId: 'c', field: 'output', text: delta }])
    }
    for (const op of queue.take() as SessionOp[]) {
      if (op.op === 'item.appendText') seen = appendOutput(seen, op.text)
      else if (op.op === 'item.appendOutput') {
        skipped++
        seen = appendSkipping(seen, op)
      } else assert.fail(`没想到的增量 ${op.op}`)
    }
    frames++
    assert.deepEqual(seen, full, `种子 ${seed} 第 ${frames} 帧之后不一样`)
  }
  return skipped
}

test('只留头尾：一帧里并起来很长时只发头尾，收的一方接出来和整段接的一模一样，什么样的输出都是', () => {
  let skipped = 0
  for (let kind = 0; kind < 4; kind++) {
    for (let seed = 1; seed <= 6; seed++) {
      const text = sample(kind, 700_000 + seed * 13_331, random(seed * 7 + kind))
      // 有的帧很大（几十段、一段上万个字），有的帧很小，接在没省过的、刚省过的、省过很久的输出后面都有
      skipped += replay(text, seed * 31 + kind, 40, 12_000)
      skipped += replay(text, seed * 17 + kind, 3, 200_000)
    }
  }
  assert.ok(skipped > 50, `只留头尾的增量一共只有 ${skipped} 条，没测到`)
})

test('只留头尾：头尾留够、中间的两头不拆开代理对，不到上限的不省', () => {
  assert.equal(skipOutput('x'.repeat(SKIP_AT)), null)
  // 两刀附近都放上代理对：前一半落在头的最后、后一半落在尾的最前
  for (const shift of [0, 1]) {
    const text = 'a'.repeat(16 * 1024 + shift) + '😀'.repeat(60_000) + 'b'.repeat(10)
    const skipping = skipOutput(text)
    assert.ok(skipping)
    assert.ok(skipping.text.length > 16 * 1024 && skipping.tail.length >= 64 * 1024)
    assert.ok(!/[\ud800-\udbff]$/.test(skipping.text), '头的最后一个字是代理对的前一半')
    assert.ok(!/^[\udc00-\udfff]/.test(skipping.tail), '尾的第一个字是代理对的后一半')
    assert.equal(skipping.text.length + skipping.skipped.chars + skipping.tail.length, text.length)
    const middle = text.slice(skipping.text.length, text.length - skipping.tail.length)
    assert.equal(skipping.skipped.bytes, new TextEncoder().encode(middle).length)
    // 接在空的、短的、很长的输出后面都和整段接的一样
    for (const before of ['', 'hello\n', 'z'.repeat(OUTPUT_KEEP * 3)]) {
      const current = appendOutput(EMPTY, before)
      assert.deepEqual(appendSkipping(current, skipping), appendOutput(current, text))
    }
  }
})
