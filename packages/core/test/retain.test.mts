// 截下来的头尾不拖着原文：核心手里留着的条目只该有上限那么大，不能因为头尾是从原文里切出来的，
// 整段原文（几 MB 到几十 MB）就跟着一直活着（V8 里切出来的一截只是指着原文的窗口，见 text/output-cap.mts 的 ownText）。
// 要在回收之后看堆，所以另起一个带 --expose-gc 的 node 进程来量；改之前留下 8 份截过的结果要拖着 8 份原文。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'

const SCRIPT = `
const core = await import(process.argv[1])
const used = () => process.memoryUsage().heapUsed
/** 一份 6M 个字上下的输出，每次都是新拼的 */
const big = (seed) => {
  const rows = []
  for (let n = 0; n < 150000; n++) rows.push('[' + seed + ':' + n + '] event · ok · padding padding\\n')
  return rows.join('')
}
const kept = []
globalThis.gc()
const before = used()
for (let round = 0; round < 8; round++) {
  const text = big(round)
  kept.push(core.capOutput(text))
  let streamed = { output: '', elided: null }
  for (let at = 0; at < text.length; at += 2_000_000) streamed = core.appendOutput(streamed, text.slice(at, at + 2_000_000))
  kept.push(streamed)
}
globalThis.gc()
globalThis.gc()
console.log(JSON.stringify({ retainedMB: (used() - before) / 1048576, kept: kept.length }))
`

test('截下来的头尾拷成自己的一份：留着几十份截过的结果，几十 MB 的原文也都能回收', () => {
  const index = new URL('../src/index.mjs', import.meta.url).href
  const out = execFileSync(
    process.execPath,
    ['--expose-gc', '--input-type=module', '-e', SCRIPT, index],
    { encoding: 'utf8' },
  )
  const { retainedMB, kept } = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
    retainedMB: number
    kept: number
  }
  assert.equal(kept, 16)
  // 16 份结果各留八万个字上下（两字节一个字，一共 3 MB），加上进程自己的零头，量到的是 15 MB 上下；
  // 拖着原文的话是 100 MB 上下（每份原文 9 MB，一边接一边截的那份拖着 4 MB 的一段增量）
  assert.ok(retainedMB < 40, `回收之后还留着 ${retainedMB.toFixed(1)} MB`)
})
