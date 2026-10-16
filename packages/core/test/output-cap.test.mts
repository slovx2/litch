// 命令输出的上限（text/output-cap.mts）：太长的只留头尾，中间记下省了多少。
// 这里只测这个纯函数本身：留下来的样子只由全文决定、和怎么分段来的无关；切的地方不拆代理对；字节数数得对；
// 上游 codex 截过的全文里那行省略说明会被认出来。经整条链路（对面 → 核心 → 通道 → 界面的副本）的在 output-flood.test.mts。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendOutput,
  type CappedOutput,
  capOutput,
  OUTPUT_HEAD,
  OUTPUT_KEEP,
  OUTPUT_REACH,
  OUTPUT_STEP,
  OUTPUT_TAIL,
  outputLength,
  utf8Length,
} from '../src/index.mjs'

const EMPTY: CappedOutput = { output: '', elided: null }

/** 每一行带着序号，看得出留的是哪几行 */
const lines = (from: number, count: number, suffix = ' building module … ok') => {
  let text = ''
  for (let n = from; n < from + count; n++) text += `[${String(n).padStart(7, '0')}]${suffix}\n`
  return text
}

/** 可以重放的伪随机数：分段的方式每次一样，失败了能复现 */
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** 按随机的长度切成很多段，一段一段接上 */
function stream(text: string, seed: number, max: number): CappedOutput {
  const next = random(seed)
  let state = EMPTY
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(next() * max)
    state = appendOutput(state, text.slice(at, at + size))
    at += size
  }
  return state
}

/**
 * 对着全文直接算出该留的样子：开头 HEAD 个字、末尾从 HEAD + k·STEP 起，两刀各挪到 REACH 以内的行与行之间
 * （开头往前、末尾往后），中间按 UTF-8 数字节。这里的全文都没有落单的代理对要躲
 */
function expected(text: string): CappedOutput {
  if (text.length < OUTPUT_KEEP) return { output: text, elided: null }
  const k = Math.floor((text.length - OUTPUT_HEAD - OUTPUT_TAIL) / OUTPUT_STEP)
  const nominal = OUTPUT_HEAD + k * OUTPUT_STEP
  const before = text.slice(OUTPUT_HEAD - OUTPUT_REACH, OUTPUT_HEAD).lastIndexOf('\n')
  const head = before < 0 ? OUTPUT_HEAD : OUTPUT_HEAD - OUTPUT_REACH + before + 1
  const after = text.slice(nominal - 1, nominal + OUTPUT_REACH - 1).indexOf('\n')
  const start = after < 0 ? nominal : nominal + after
  const middle = text.slice(head, start)
  return {
    output: text.slice(0, head),
    elided: {
      chars: middle.length,
      bytes: new TextEncoder().encode(middle).length,
      tail: text.slice(start),
    },
  }
}

test('输出上限：不到上限的一个字都不省，到了之后开头留固定的一截、末尾留够数', () => {
  const short = lines(1, 100)
  assert.deepEqual(capOutput(short), { output: short, elided: null })
  const edge = 'x'.repeat(OUTPUT_KEEP - 1)
  assert.deepEqual(capOutput(edge), { output: edge, elided: null })
  for (const size of [OUTPUT_KEEP, OUTPUT_KEEP + 1, 3 * OUTPUT_KEEP + 12_345]) {
    const text = lines(1, Math.ceil(size / 20)).slice(0, size)
    assert.equal(text.length, size)
    const capped = capOutput(text)
    assert.deepEqual(capped, expected(text))
    const tail = capped.elided?.tail.length ?? 0
    assert.ok(
      tail > OUTPUT_TAIL - OUTPUT_REACH && tail < OUTPUT_TAIL + OUTPUT_STEP,
      `末尾留了 ${tail} 个字`,
    )
    assert.equal(outputLength(capped), text.length)
    assert.ok(capped.output.length + tail < OUTPUT_KEEP)
    // 每行都不长：两刀都落在行与行之间
    assert.ok(capped.output.endsWith('\n'), '开头那一截停在一行的末尾')
    assert.ok(capped.elided?.tail.startsWith('['), '末尾那一截从一行的开头起')
  }
})

test('输出上限：切的地方挪到行与行之间；一行太长、附近没有换行时照字数切', () => {
  // 开头那一刀前面不远有换行，末尾那一刀附近的一行比 REACH 还长
  const head = `${'h'.repeat(OUTPUT_HEAD - 100)}\n${'i'.repeat(300)}`
  const total = OUTPUT_KEEP + 5
  const nominal = OUTPUT_HEAD + OUTPUT_STEP
  let text = `${head}${'m\n'.repeat(Math.floor((nominal - 2 * OUTPUT_REACH - head.length) / 2))}`
  text += 'L'.repeat(total - text.length)
  assert.equal(text.length, total)
  for (const capped of [capOutput(text), stream(text, 21, 999)]) {
    assert.deepEqual(capped, expected(text))
    assert.equal(capped.output.length, OUTPUT_HEAD - 99, '开头那一截停在那个换行之后')
    assert.equal(outputLength(capped) - (capped.elided?.tail.length ?? 0), nominal, '末尾照字数切')
  }
  // 末尾那一刀本来就落在行首：不往后挪
  const aligned = `${'a\n'.repeat(nominal / 2)}${'z'.repeat(total - nominal)}`
  assert.equal(capOutput(aligned).elided?.tail.length, total - nominal)
  // 换行在末尾那一刀之后 REACH - 1 个字处还算，再远就不算
  for (const [gap, start] of [
    [OUTPUT_REACH - 2, nominal + OUTPUT_REACH - 1],
    [OUTPUT_REACH - 1, nominal],
  ] as const) {
    const far = `${'q'.repeat(nominal)}${'r'.repeat(gap)}\n${'s'.repeat(total - nominal - gap - 1)}`
    const capped = capOutput(far)
    assert.equal(outputLength(capped) - (capped.elided?.tail.length ?? 0), start, `隔 ${gap} 个字`)
    assert.deepEqual(capped, expected(far))
  }
})

test('输出上限：一段一段接上和整段一次截好，结果一模一样，不管怎么分段', () => {
  const text = lines(1, 30_000)
  const whole = capOutput(text)
  assert.deepEqual(whole, expected(text))
  for (const [seed, max] of [
    [1, 7],
    [2, 300],
    [3, 9000],
    [4, 70_000],
    [5, 400_000],
  ] as const) {
    assert.deepEqual(stream(text, seed, max), whole, `分段方式 ${seed}（每段至多 ${max} 个字）`)
  }
  // 先拿到半截（恢复会话时对面给的到此为止的全文），再接着收增量
  const half = Math.floor(text.length * 0.37)
  assert.deepEqual(appendOutput(capOutput(text.slice(0, half)), text.slice(half)), whole)
  // 行有长有短，有的比 REACH 还长：切的地方有时挪到行与行之间、有时照字数切，分段方式照样不影响结果
  const next = random(77)
  let ragged = ''
  while (ragged.length < 600_000) {
    const long = next() < 0.05
    ragged += `${'w'.repeat(Math.floor(next() * (long ? 4 * OUTPUT_REACH : 120)))}\n`
  }
  const raggedWhole = capOutput(ragged)
  assert.deepEqual(raggedWhole, expected(ragged))
  for (const [seed, max] of [
    [6, 13],
    [7, 5000],
    [8, 60_000],
  ] as const) {
    assert.deepEqual(stream(ragged, seed, max), raggedWhole, `长短不一的行，分段方式 ${seed}`)
  }
})

test('输出上限：切的地方不拆开代理对，头尾和中间的字节数都对得上', () => {
  // 一个 emoji 占两个码元：让开头那一刀、末尾那一刀都正好落在一对的中间
  const emoji = '😀'
  const total = OUTPUT_HEAD + OUTPUT_TAIL + 3 * OUTPUT_STEP + 1
  const start = OUTPUT_HEAD + 3 * OUTPUT_STEP
  let text = `${'a'.repeat(OUTPUT_HEAD - 1)}${emoji}${'中'.repeat(OUTPUT_STEP)}`
  text += 'c'.repeat(start - 1 - text.length)
  text += emoji
  text += 'd'.repeat(total - text.length)
  assert.equal(text.length, total)
  for (const capped of [capOutput(text), stream(text, 9, 5000), stream(text, 10, 3)]) {
    const { output, elided } = capped
    assert.ok(elided)
    assert.equal(output.length, OUTPUT_HEAD - 1, '开头那一刀往前挪了一个字')
    assert.ok(output.endsWith('a'), '开头那一截的末尾不是半个代理对')
    assert.equal(output.length + elided.chars, start + 1, '末尾那一刀往后挪了一个字')
    assert.ok(elided.tail.startsWith('d'), '整个 emoji 算在省掉的里面')
    const dropped = text.slice(output.length, output.length + elided.chars)
    assert.equal(elided.bytes, new TextEncoder().encode(dropped).length)
    assert.equal(outputLength(capped), text.length)
  }
})

test('输出上限：UTF-8 字节数，ASCII 为主、中文为主、落单的半个代理对都数得对', () => {
  const encode = (text: string) => new TextEncoder().encode(text).length
  const samples = [
    lines(1, 500),
    '中文为主的日志：正在编译第一个模块，一切正常\n'.repeat(400),
    `ascii ${'é'.repeat(30)} 中 😀 end\n`.repeat(200),
    `${'x'.repeat(300)}😀${'y'.repeat(300)}`,
  ]
  for (const text of samples) {
    assert.equal(utf8Length(text), encode(text))
    assert.equal(utf8Length(text, 17, text.length - 5), encode(text.slice(17, text.length - 5)))
  }
  // 落单的半个代理对按替换符算 3 个字节；两个落单的中间隔着 ASCII，不会被凑成一对
  assert.equal(utf8Length('a\ud800b\udc00c'), 3 + 3 + 3)
  assert.equal(utf8Length(`${'a'.repeat(300)}\ud800${'b'.repeat(10)}\udc00`), 300 + 3 + 10 + 3)
})

test('输出上限：上游 codex 截过的全文，省略说明那一行算进省了多少，和实时接着看到的对得上', () => {
  // 上游留头尾各 512 KB，中间写一行“... N bytes omitted ...”。用 ASCII 的输出，字节数等于字数
  const full = lines(1, 120_000, ' building module ... ok')
  const keep = 512 * 1024
  const said = full.length - 2 * keep
  const truncated = `${full.slice(0, keep)}\n... ${said} bytes omitted ...\n${full.slice(-keep)}`
  const live = stream(full, 11, 8192)
  const read = capOutput(truncated)
  assert.ok(live.elided && read.elided)
  assert.equal(read.output, live.output)
  // 末尾从哪里留按全文里的位置对齐，上游省掉的那些我们只知道字节数、不知道字数，所以末尾两边可能差不到一步；
  // 留的都是全文的末尾，而且“省掉的 + 末尾留着的”两边一样多（开头一样长）
  assert.ok(full.endsWith(read.elided.tail) && full.endsWith(live.elided.tail))
  assert.ok(read.elided.tail.length > OUTPUT_TAIL - OUTPUT_REACH)
  assert.equal(
    read.elided.bytes + read.elided.tail.length,
    live.elided.bytes + live.elided.tail.length,
  )
  assert.ok(Math.abs(read.elided.bytes - live.elided.bytes) < OUTPUT_STEP + OUTPUT_REACH)
  // 两行这样的字就不认：分不清哪一行是上游写的，照实数
  const twice = `${truncated.slice(0, 200_000)}\n... 5 bytes omitted ...\n${truncated.slice(200_000)}`
  const plain = capOutput(twice)
  const kept = plain.output.length
  const dropped = twice.slice(kept, kept + (plain.elided?.chars ?? 0))
  assert.equal(plain.elided?.bytes, dropped.length)
})
