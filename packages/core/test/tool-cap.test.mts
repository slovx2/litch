// 工具调用（MCP、动态工具、函数工具）的参数和结果的上限（text/tool-cap.mts）和各种段的投影（projection/items.mts）。
// 只测纯函数：段怎么投影、多长时怎么截、截出来的段先后和种类不变、省了多少数得对。
// 经整条链路（对面 → 核心 → 通道 → 界面的副本）三条路是不是一样，在 tool-flood.test.mts。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import {
  capOutput,
  capParts,
  OUTPUT_KEEP,
  PART_CHARS,
  projectItem,
  type ToolCallItem,
  type ToolPart,
  utf8Length,
} from '../src/index.mjs'

/** 每一行带着序号，看得出留的是哪几行 */
const lines = (from: number, count: number, suffix = ' row … ok') => {
  let text = ''
  for (let n = from; n < from + count; n++) text += `[${String(n).padStart(7, '0')}]${suffix}\n`
  return text
}

const mcp = (result: unknown, args: unknown = { q: 'x' }): ThreadItem =>
  ({
    type: 'mcpToolCall',
    id: 'm',
    server: 'docs',
    tool: 'dump',
    status: 'completed',
    arguments: args,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
    result,
    error: null,
    durationMs: 40,
  }) as ThreadItem

const toolCall = (item: ThreadItem): ToolCallItem => {
  const view = projectItem(item)
  assert.equal(view.kind, 'toolCall')
  return view as ToolCallItem
}

const texts = (parts: ToolPart[]) => parts.filter((part) => part.kind === 'text')
const textChars = (parts: ToolPart[]) =>
  texts(parts).reduce((sum, part) => sum + (part.kind === 'text' ? part.text.length : 0), 0)
const gaps = (parts: ToolPart[]) => parts.filter((part) => part.kind === 'gap')

test('工具结果：不长的原样留；图片、音频、资源只留种类、格式和大小，认不出的段排成 JSON', () => {
  const png = 'A'.repeat(4000)
  const item = toolCall(
    mcp({
      content: [
        { type: 'text', text: '三条结果' },
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        {
          type: 'resource',
          resource: { uri: 'file:///a.md', mimeType: 'text/markdown', text: '读了' },
        },
        { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AAAAAA==' } },
        { type: 'resource_link', uri: 'file:///c.txt', name: 'c', size: 12 },
        { type: 'chart', points: [1, 2] },
      ],
      structuredContent: { ignored: true },
      _meta: null,
    }),
  )
  assert.deepEqual(item.input, [{ kind: 'text', text: '{\n  "q": "x"\n}' }])
  assert.deepEqual(item.output, [
    { kind: 'text', text: '三条结果' },
    { kind: 'blob', type: 'image', mime: 'image/png', bytes: 3000, name: null },
    { kind: 'blob', type: 'audio', mime: 'audio/wav', bytes: 3, name: null },
    { kind: 'blob', type: 'resource', mime: 'text/markdown', bytes: 6, name: 'file:///a.md' },
    { kind: 'blob', type: 'resource', mime: null, bytes: 4, name: 'file:///b.bin' },
    { kind: 'blob', type: 'link', mime: null, bytes: 12, name: 'file:///c.txt' },
    { kind: 'text', text: '{"type":"chart","points":[1,2]}' },
  ])
  // 图片的内容不进显示条目
  assert.ok(JSON.stringify(item).length < 1000)

  // 一段文字都没有时补上结构化的结果；没有结果是空的
  assert.deepEqual(
    toolCall(
      mcp({
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/gif' }],
        structuredContent: { rows: 2 },
        _meta: null,
      }),
    ).output,
    [
      { kind: 'blob', type: 'image', mime: 'image/gif', bytes: 3, name: null },
      { kind: 'text', text: '{\n  "rows": 2\n}' },
    ],
  )
  assert.deepEqual(toolCall(mcp(null, null)).output, [])
  assert.deepEqual(toolCall(mcp(null, null)).input, [])

  // 动态工具：图片是地址，内联的记格式和大小，别的只记地址；能直接显示的内联图片留着地址（界面画缩略图）
  const dynamic = toolCall({
    type: 'dynamicToolCall',
    id: 'd',
    namespace: 'claude',
    tool: 'Read',
    arguments: {},
    status: 'completed',
    contentItems: [
      { type: 'inputText', text: '第一段' },
      { type: 'inputImage', imageUrl: 'data:image/webp;base64,AAAAAAA=' },
      { type: 'inputImage', imageUrl: 'https://example.com/a.png' },
    ],
    success: true,
    durationMs: 5,
  })
  assert.deepEqual(dynamic.output, [
    { kind: 'text', text: '第一段' },
    {
      kind: 'blob',
      type: 'image',
      mime: 'image/webp',
      bytes: 5,
      name: null,
      src: 'data:image/webp;base64,AAAAAAA=',
    },
    { kind: 'blob', type: 'image', mime: null, bytes: null, name: 'https://example.com/a.png' },
  ])

  // 函数工具：输出是一段字，或者 Responses 写法的几段
  const fn = (output: unknown) =>
    toolCall({
      type: 'functionCallOutput',
      id: 'f',
      name: 'shell',
      namespace: null,
      output,
    } as ThreadItem)
  assert.deepEqual(fn('ok').output, [{ kind: 'text', text: 'ok' }])
  assert.deepEqual(fn('').output, [])
  assert.deepEqual(
    fn([
      { type: 'input_text', text: '看图' },
      { type: 'input_image', file_id: 'file-1' },
      { type: 'encrypted_content', encrypted_content: 'xyz' },
    ]).output,
    [
      { kind: 'text', text: '看图' },
      { kind: 'blob', type: 'image', mime: null, bytes: null, name: 'file-1' },
      { kind: 'blob', type: 'other', mime: null, bytes: 3, name: 'encrypted_content' },
    ],
  )
})

test('工具结果：只有一段很长的文字时，截出来和命令输出一模一样', () => {
  for (const text of [lines(1, 30_000), `${'x'.repeat(200_000)}\n${'中'.repeat(90_000)}`]) {
    const capped = capOutput(text)
    assert.ok(capped.elided)
    assert.deepEqual(capParts([{ kind: 'text', text }]), [
      { kind: 'text', text: capped.output },
      { kind: 'gap', chars: capped.elided.chars, bytes: capped.elided.bytes, parts: 0 },
      { kind: 'text', text: capped.elided.tail },
    ])
  }
  // 不到上限的整段留，连同一个数组都不换
  const short: ToolPart[] = [{ kind: 'text', text: lines(1, 10) }]
  assert.equal(capParts(short), short)
})

test('工具结果：几千段文字夹着图片，整体只留头尾；段的先后和种类不变，省了多少数得对', () => {
  const parts: ToolPart[] = []
  let total = 0
  let images = 0
  for (let n = 1; n <= 4000; n++) {
    const text = `[${String(n).padStart(5, '0')}] 第 ${n} 段结果 … ok`
    parts.push({ kind: 'text', text })
    total += text.length
    if (n % 7 === 0) {
      parts.push({ kind: 'blob', type: 'image', mime: 'image/png', bytes: n, name: null })
      images++
    }
  }
  const capped = capParts(parts)
  const [gap, ...more] = gaps(capped)
  assert.ok(gap?.kind === 'gap' && more.length === 0, '省过的结果里正好一处省略')
  // 留下的文字和段数都有上限：每一段（连同和下一段之间的分隔）至少算 PART_CHARS 个字
  const kept = textChars(capped)
  const blobs = capped.filter((part) => part.kind === 'blob').length
  const virtual = kept + blobs * PART_CHARS + (capped.length - 3) * PART_CHARS
  assert.ok(virtual <= OUTPUT_KEEP, `留了 ${kept} 个字、${capped.length - 1} 段（${blobs} 段图片）`)
  // 第一段、最后一段都在，省掉的就在中间
  assert.deepEqual(capped[0], parts[0])
  assert.deepEqual(capped.at(-1), parts.at(-1))
  const at = capped.indexOf(gap)
  assert.deepEqual(capped.slice(0, at), parts.slice(0, at))
  assert.deepEqual(capped.slice(at + 1), parts.slice(parts.length - (capped.length - at - 1)))
  // 段与段之间就是换行，刀口落在段与段之间：留着的段都是原样的
  for (const part of capped) if (part.kind !== 'gap') assert.ok(parts.includes(part))
  // 省掉的字、字节和图片对得上
  assert.equal(kept + gap.chars, total)
  assert.equal(blobs + gap.parts, images)
  const dropped = parts.slice(at, parts.length - (capped.length - at - 1))
  assert.equal(
    gap.bytes,
    dropped.reduce((sum, part) => sum + (part.kind === 'text' ? utf8Length(part.text) : 0), 0),
  )
})

test('工具结果：一万段图片也只留上限那么多段，其余记段数', () => {
  const parts: ToolPart[] = Array.from({ length: 10_000 }, (_, n) => ({
    kind: 'blob',
    type: 'image',
    mime: 'image/png',
    bytes: n,
    name: null,
  }))
  const capped = capParts(parts)
  const blobs = capped.filter((part) => part.kind === 'blob').length
  assert.ok((blobs - 1) * 2 * PART_CHARS <= OUTPUT_KEEP, `留了 ${blobs} 段`)
  const [gap] = gaps(capped)
  assert.ok(gap?.kind === 'gap')
  assert.equal(gap.chars, 0)
  assert.equal(gap.bytes, 0)
  assert.equal(blobs + gap.parts, 10_000)
})

test('工具结果：刀落在文字段中间时不拆开代理对，字节按 UTF-8 数', () => {
  // 没有换行的一大段（照字数切），前后各有别的段
  const emoji = '😀'.repeat(60_000)
  const parts: ToolPart[] = [
    { kind: 'text', text: 'head' },
    { kind: 'text', text: emoji },
    { kind: 'blob', type: 'audio', mime: null, bytes: 1, name: null },
  ]
  const capped = capParts(parts)
  for (const part of capped) {
    if (part.kind !== 'text') continue
    assert.ok(!/^[\udc00-\udfff]/.test(part.text) && !/[\ud800-\udbff]$/.test(part.text))
  }
  const [gap] = gaps(capped)
  assert.ok(gap?.kind === 'gap')
  assert.equal(gap.bytes, (gap.chars / 2) * 4)
  assert.deepEqual(capped.at(-1), parts.at(-1))
})

test('工具调用：几十 MB 的参数和结果投影出来只有上限那么大，图片的内容不进来', () => {
  const big = lines(1, 600_000)
  const item = toolCall(
    mcp(
      {
        content: [
          { type: 'text', text: big },
          { type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' },
          { type: 'text', text: '最后一段' },
        ],
        structuredContent: null,
        _meta: null,
      },
      { path: '/var/log/app.log', content: big },
    ),
  )
  const size = JSON.stringify(item).length
  assert.ok(size <= 2 * OUTPUT_KEEP + 10_000, `显示条目有 ${size} 个字`)
  // 结果：开头是最前那几行，末尾那一段和它前面的图片都留着，中间标出省了多少
  const first = item.output[0]
  assert.ok(first?.kind === 'text' && first.text.startsWith('[0000001] row'))
  assert.deepEqual(item.output.slice(-2), [
    { kind: 'blob', type: 'image', mime: 'image/png', bytes: 1536 * 1024, name: null },
    { kind: 'text', text: '最后一段' },
  ])
  const [gap] = gaps(item.output)
  assert.ok(gap?.kind === 'gap' && gap.bytes > 10 * 1024 * 1024)
  // 参数也一样截
  assert.equal(gaps(item.input).length, 1)
})

test('工具调用：MCP 的错误信息太长时和结果一样只留头尾，短的原样一段', () => {
  const failed = (message: string): ToolCallItem =>
    toolCall({
      ...(mcp(null) as Extract<ThreadItem, { type: 'mcpToolCall' }>),
      status: 'failed',
      error: { message },
    } as ThreadItem)
  // 几 MB 的错误（MCP 服务把整段堆栈、整份请求塞进了错误里）
  const big = lines(1, 200_000)
  const item = failed(big)
  const size = JSON.stringify(item).length
  assert.ok(size <= OUTPUT_KEEP + 10_000, `显示条目有 ${size} 个字`)
  const capped = capOutput(big)
  assert.ok(capped.elided)
  assert.deepEqual(item.error, [
    { kind: 'text', text: capped.output },
    { kind: 'gap', chars: capped.elided.chars, bytes: capped.elided.bytes, parts: 0 },
    { kind: 'text', text: capped.elided.tail },
  ])
  // 不长的原样
  assert.deepEqual(failed('连接被拒绝').error, [{ kind: 'text', text: '连接被拒绝' }])
})
