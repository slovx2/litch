import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import type * as PiSdk from '@earendil-works/pi-coding-agent'
import { freshOutput, outputDelta } from '../src/command-output.mjs'
import { hostPi } from '../src/versions.mjs'

// 命令还在跑时的输出增量。Pi 给的是快照（全文，或者输出过了 2000 行、50KB 之后末尾的一个窗口），
// 发给客户端的得是新增的一段：以前窗口一开始滑，每条增量发的就是整个窗口，客户端接起来是一遍遍重复的输出。
// 001 到 005 对着 Pi 真的 bash 工具：命令换成用例自己喂输出的假执行器，时钟拿在手里，每喂一段正好出一份快照，
// 结果和机器快慢无关。006 是 Pi 自己的 bash 不会给、换掉内置 bash 的扩展可能给的样子（快照里没有字节数）。
// 经过整个入口、跑真命令的那一条在 long-stream.test.mts（STREAM-PI-003）。

const sdk: typeof PiSdk = await import(pathToFileURL(hostPi().sdkEntry).href)

interface Streamed {
  /** 该发给客户端的增量，按先后 */
  deltas: string[]
  /** Pi 各份快照的字数：以前窗口滑起来之后每条增量就是这么长 */
  windows: number[]
  /** 命令结束时 Pi 给的结果，条目完成时的 aggregatedOutput 就是它 */
  final: string
}

/** 让 Pi 的 bash 工具“跑”一条命令：输出就是 chunks，一段一份快照 */
async function stream(t: TestContext, chunks: string[]): Promise<Streamed> {
  // 工具给快照有节流（两份之间至少隔 100 毫秒）：每喂一段把钟拨过去一格
  t.mock.timers.reset()
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const call = { item: { aggregatedOutput: null as string | null } }
  const deltas: string[] = []
  const windows: number[] = []
  const exec: PiSdk.BashOperations['exec'] = async (_command, _cwd, { onData }) => {
    for (const chunk of chunks) {
      onData(Buffer.from(chunk))
      t.mock.timers.tick(100)
    }
    return { exitCode: 0 }
  }
  const tool = sdk.createBashToolDefinition('/', { operations: { exec } })
  const update = (partial: unknown) => {
    const delta = outputDelta(call, partial)
    if (!delta) return
    deltas.push(delta)
    windows.push(call.item.aggregatedOutput?.length ?? 0)
    // 客户端一路接起来的，总是以 Pi 这一刻的窗口结尾
    assert.ok(deltas.join('').endsWith(call.item.aggregatedOutput ?? ''), '接起来的以窗口结尾')
  }
  const result = await tool.execute(
    'call',
    { command: 'fake' },
    undefined,
    update,
    undefined as never,
  )
  // 输出被截过的话 Pi 把全文留在临时目录的一个文件里
  if (result.details?.fullOutputPath) await rm(result.details.fullOutputPath, { force: true })
  const final = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  return { deltas, windows, final }
}

const sum = (numbers: number[]) => numbers.reduce((total, n) => total + n, 0)
/** from 到 to 每个数一行 */
const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => `${from + index}\n`).join('')

test('OUTPUT-PI-001：输出过了行数上限，窗口往后滑，每条增量仍然只是新增的一段', async (t) => {
  // 四十段、每段三百行：过了两千行之后，窗口每份快照往后滑三百行
  const chunks = Array.from({ length: 40 }, (_, index) => lines(index * 300 + 1, index * 300 + 300))
  const { deltas, windows, final } = await stream(t, chunks)
  assert.equal(deltas.length, chunks.length)
  // 窗口还没满时照常是新增的一段
  assert.deepEqual(deltas.slice(0, 6), chunks.slice(0, 6))
  // 接起来是命令的全部输出，不多不少（截过的快照末尾的换行 Pi 去掉了）
  assert.equal(deltas.join(''), chunks.join('').slice(0, -1))
  // 以前发的是各份快照本身，加起来是实际输出的好几倍
  assert.ok(sum(windows) > chunks.join('').length * 5)
  // 条目完成时是 Pi 给的最后一个窗口加一句说明，比一路接起来的短，客户端以它为准
  assert.ok(final.startsWith(lines(10001, 12000).slice(0, -1)), final.slice(0, 200))
  assert.ok(final.length < deltas.join('').length / 4)
})

test('OUTPUT-PI-002：行长的输出先到字节上限，一样只发新增的一段', async (t) => {
  // 每行一百个字，五百来行就到 50KB，行数上限碰不到
  const row = (index: number) => `${String(index).padStart(6, '0')} ${'x'.repeat(92)}\n`
  const chunks = Array.from({ length: 30 }, (_, chunk) =>
    Array.from({ length: 100 }, (_, index) => row(chunk * 100 + index)).join(''),
  )
  const { deltas, windows } = await stream(t, chunks)
  assert.equal(deltas.join(''), chunks.join('').slice(0, -1))
  assert.ok(Math.max(...windows) <= 50 * 1024)
  // 行有空行、段末连着两个换行的时候也对得上
  const spaced = Array.from({ length: 30 }, (_, chunk) => `第 ${chunk} 段\n\n`.repeat(100))
  assert.equal((await stream(t, spaced)).deltas.join(''), spaced.join('').slice(0, -1))
})

test('OUTPUT-PI-003：输出里全是重复的行，单看文字分不出窗口滑了多少，照 Pi 报的字节数发', async (t) => {
  const chunks = Array.from({ length: 30 }, () => 'same line\n'.repeat(300))
  const { deltas, windows } = await stream(t, chunks)
  // 窗口满了之后前后两份快照一字不差，新增的三百行照样发出去
  assert.equal(windows.at(-1), windows.at(-2))
  assert.equal(deltas.length, chunks.length)
  assert.equal(deltas.join(''), chunks.join('').slice(0, -1))
  // 一会儿重复一会儿不重复
  const mixed = Array.from({ length: 30 }, (_, index) =>
    index % 3 === 2 ? lines(index * 300, index * 300 + 299) : 'PASS\n'.repeat(300),
  )
  assert.equal((await stream(t, mixed)).deltas.join(''), mixed.join('').slice(0, -1))
})

test('OUTPUT-PI-004：没有换行的超长单行（窗口是这一行的末尾 50KB），多字节的字按字节数对', async (t) => {
  // 一段两千多个字、六千多字节，一共二十多万字节的一行
  const chunks = Array.from({ length: 40 }, (_, index) => `字块${index}，`.repeat(600))
  const long = await stream(t, chunks)
  assert.equal(long.deltas.length, chunks.length)
  assert.equal(long.deltas.join(''), chunks.join(''))
  assert.ok(sum(long.windows) > chunks.join('').length * 3)
  // 长行后面换了行、又出了别的：窗口里只剩后面的短行，和旧窗口一个字都对不上，接起来仍然是原样
  // （窗口里的行没到上限，这时 Pi 不去掉末尾的换行）
  const after = [...chunks, '\n收尾第一行\n', '收尾第二行\n']
  assert.equal((await stream(t, after)).deltas.join(''), after.join(''))
})

test('OUTPUT-PI-005：两份快照之间输出的比一个窗口还多，中间的丢了，新窗口另起一行整个发', async (t) => {
  const chunks = [lines(1, 100), lines(101, 5100), lines(5101, 5200), lines(5201, 10200)]
  const { deltas } = await stream(t, chunks)
  // 第二段五千行，窗口只留得住末尾两千行；第四段又是五千行。丢的是 101 到 3100、5201 到 8200
  const kept = lines(1, 100) + lines(3101, 5200) + lines(8201, 10200)
  assert.equal(deltas.join(''), kept.slice(0, -1))
  assert.equal(deltas.length, chunks.length)
  // 重复的内容也一样：一次出了五千行同样的字，窗口和上一份一字不差，但整个都是新的
  const same = ['same\n'.repeat(5000), 'same\n'.repeat(5000)]
  assert.equal((await stream(t, same)).deltas.join(''), 'same\n'.repeat(4000).slice(0, -1))
})

test('OUTPUT-PI-006：快照里没有字节数时只凭文字对：取重叠最长的接法，不把发过的再发一遍', () => {
  // 全文在变长
  assert.equal(freshOutput('', '第一行\n'), '第一行\n')
  assert.equal(freshOutput('第一行\n', '第一行\n第二行\n'), '第二行\n')
  assert.equal(freshOutput('第一行\n', '第一行\n'), '')
  // 末尾的窗口往后滑了：旧窗口的后一截是新窗口的开头
  const window = (from: number, to: number) => lines(from, to).slice(0, -1)
  assert.equal(freshOutput(window(1, 2000), window(301, 2300)), `\n${window(2001, 2300)}`)
  // 滑动的位置不在行首（单行的末尾一截）
  assert.equal(freshOutput('abcdefgh', 'defghijk'), 'ijk')
  // 有重复的行，但窗口里不全是：只有一种接法
  const passes = 'PASS\n'.repeat(1500)
  assert.equal(freshOutput(`头\n${passes}尾`, `${passes}尾\n再来一行`), '\n再来一行')
  // 窗口里全是同一行：分不出滑没滑，不发
  assert.equal(freshOutput('y\n'.repeat(2000), 'y\n'.repeat(2000)), '')
  assert.equal(freshOutput('y\n'.repeat(2000), `${'y\n'.repeat(1999)}完`), '完')
  // 一个字都对不上：另起一行整个发；上一份本来就以换行结尾的不多加
  assert.equal(freshOutput(window(1, 2000), window(5001, 7000)), `\n${window(5001, 7000)}`)
  assert.equal(freshOutput('旧的\n', '新的'), '新的')
  assert.equal(freshOutput('旧的', ''), '')
  // 字节数只用来在文字对得上的几种接法里挑：对不上号的数（零、负的）挑出来的还是对得上的那种
  assert.equal(freshOutput(window(1, 2000), window(301, 2300), 0), `\n${window(2001, 2300)}`)
  assert.equal(freshOutput('abcdefgh', 'defghijk', -5), 'ijk')
})
