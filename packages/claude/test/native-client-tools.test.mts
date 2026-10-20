import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 动态工具（含 clientTools 扩展的客户端工具，protocol/extensions/client-tools.json）在真实 CLI 上的两件事：
//   - 动态工具的调用一律不经 Claude Code 的权限审批、不按沙箱拦（和原生 codex 一样，执行方是客户端，
//     要不要问用户由它定），不分是不是 litch_ 命名空间；
//   - 结果里的大图片原样交给模型：SDK 不截断、不落盘换成路径。

const ECHO_TOOLS = [
  {
    type: 'namespace',
    name: 'litch_echo',
    description: 'Litch 测试工具',
    tools: [
      {
        type: 'function',
        name: 'echo',
        description: '原样回参数',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
  },
]
const CAPABILITIES = {
  litchExtensions: ['clientTools'],
  litchClientTools: { namespaces: ['litch_echo'] },
}

/** 一张不压缩的随机像素 PNG，大小大约是 side*side*3 字节 */
function noisePng(side: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  header[8] = 8
  header[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < side; y++) rows.push(Buffer.concat([Buffer.alloc(1), randomBytes(side * 3)]))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 模型请求里最后一条 tool_result 的内容块 */
function lastToolResult(request: any): any[] {
  for (const message of [...(request.messages ?? [])].reverse())
    for (const block of Array.isArray(message.content) ? [...message.content].reverse() : [])
      if (block.type === 'tool_result') return Array.isArray(block.content) ? block.content : []
  return []
}

const callEcho = (request: any) => {
  const tool = request.tools.find((entry: any) =>
    entry.name.startsWith('mcp__codex_harness_adapter__'),
  )
  assert.ok(tool, '动态工具应在模型请求里')
  return [{ type: 'tool_use', id: 'toolu_client', name: tool.name, input: { text: 'hi' } }]
}

for (const [label, settings] of [
  ['按需审批、工作区可写', { approvalPolicy: 'on-request', sandbox: 'workspace-write' }],
  ['不信任、只读', { approvalPolicy: 'untrusted', sandbox: 'read-only' }],
  ['从不审批、只读', { approvalPolicy: 'never', sandbox: 'read-only' }],
  ['计划模式', { approvalPolicy: 'on-request', sandbox: 'workspace-write', planMode: true }],
] as const)
  test(`CLIENT-TOOLS-CC-001：${label}时 litch_ 命名空间的动态工具调用不经审批，直接交给客户端`, {
    timeout: 100_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-client-tools-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(
      home,
      await model.start(),
      false,
      'api-key',
      {},
      CAPABILITIES,
    )
    try {
      const asked: string[] = []
      client.onServerRequest = async (method, params) => {
        asked.push(method)
        if (method === 'item/tool/call')
          return {
            success: true,
            contentItems: [{ type: 'inputText', text: `ECHO ${params.arguments.text}` }],
          }
        if (method === 'item/tool/requestUserInput') return { answers: {} }
        return { decision: 'decline' }
      }
      model.enqueue(callEcho)
      model.enqueue((request) => {
        assert.match(JSON.stringify(lastToolResult(request)), /ECHO hi/)
        return [{ type: 'text', text: 'DONE' }]
      })
      const { planMode, ...threadSettings } = settings as typeof settings & { planMode?: boolean }
      const { thread } = await client.request('thread/start', {
        cwd: home,
        ...threadSettings,
        dynamicTools: ECHO_TOOLS,
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '调用工具' }],
        ...(planMode ? { planMode: true } : {}),
      })
      const completed = await client.completed(turn.id)
      assert.equal(
        completed.status,
        'completed',
        JSON.stringify({
          completed,
          asked,
          last: model.requests.map((request: any) =>
            JSON.stringify(request.messages?.at(-1)).slice(0, 600),
          ),
        }),
      )
      assert.deepEqual(asked, ['item/tool/call'], '只有工具调用，没有审批')
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

const ECHO_FUNCTION = (ECHO_TOOLS[0] as { tools: unknown[] }).tools[0]
for (const [label, settings, dynamicTools] of [
  [
    '从不审批、工作区可写，别的命名空间',
    { approvalPolicy: 'never', sandbox: 'workspace-write' },
    [{ ...ECHO_TOOLS[0], name: 'fixture_tools' }],
  ],
  [
    '从不审批、工作区可写，不带命名空间',
    { approvalPolicy: 'never', sandbox: 'workspace-write' },
    [ECHO_FUNCTION],
  ],
  [
    '按需审批、工作区可写，别的命名空间',
    { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
    [{ ...ECHO_TOOLS[0], name: 'fixture_tools' }],
  ],
] as const)
  test(`CLIENT-TOOLS-CC-003：${label}时动态工具同样不经审批、不按沙箱拦，直接交给客户端`, {
    timeout: 100_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-client-tools-other-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start(), false, 'api-key', {}, null)
    try {
      const asked: string[] = []
      client.onServerRequest = async (method) => {
        asked.push(method)
        return method === 'item/tool/call'
          ? { success: true, contentItems: [{ type: 'inputText', text: 'ECHO hi' }] }
          : { decision: 'decline' }
      }
      model.enqueue(callEcho)
      model.enqueue((request) => {
        assert.match(JSON.stringify(lastToolResult(request)), /ECHO hi/)
        return [{ type: 'text', text: 'DONE' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        ...settings,
        dynamicTools,
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '调用工具' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      assert.deepEqual(asked, ['item/tool/call'], '只有工具调用，没有审批')
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

/** 模型收到的图片块解出来的宽高（PNG 读 IHDR，JPEG 读 SOF） */
function imageSize(data: Buffer): string {
  if (data[0] === 0x89) return `${data.readUInt32BE(16)}x${data.readUInt32BE(20)}`
  for (let i = 0; i < data.length - 9; i++)
    if (data[i] === 0xff && (data[i + 1] === 0xc0 || data[i + 1] === 0xc2))
      return `${data.readUInt16BE(i + 7)}x${data.readUInt16BE(i + 5)}`
  return '?'
}

// 截图大的时候 Claude Code 会自己压（实测 2.1.282：约 270KB 的 PNG 原样交，1MB 起转码，边长超过 2000 缩到 2000），
// 但都是整张图交给模型，不截断、不落盘换成路径
for (const [label, side, identical] of [
  ['小图原样交给模型', 300, true],
  ['2MB 的图整张交给模型（CLI 自己转码），不截断、不换成文件路径', 830, false],
] as const)
  test(`CLIENT-TOOLS-CC-002：${label}`, { timeout: 100_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-client-image-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(
      home,
      await model.start(),
      false,
      'api-key',
      {},
      CAPABILITIES,
    )
    try {
      const png = noisePng(side)
      if (!identical) assert.ok(png.length > 2_000_000, `图片应超过 2MB：${png.length}`)
      const data = png.toString('base64')
      client.onTool = async () => ({
        success: true,
        contentItems: [
          { type: 'inputText', text: 'SCREENSHOT' },
          { type: 'inputImage', imageUrl: `data:image/png;base64,${data}` },
        ],
      })
      let seen: any[] = []
      model.enqueue(callEcho)
      model.enqueue((request) => {
        seen = lastToolResult(request)
        return [{ type: 'text', text: 'DONE' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        dynamicTools: ECHO_TOOLS,
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '截图' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      const summary = JSON.stringify(
        seen.map((block) =>
          block.type === 'image'
            ? { type: 'image', media: block.source?.media_type, length: block.source?.data?.length }
            : { type: block.type, text: String(block.text ?? '').slice(0, 200) },
        ),
      )
      const images = seen.filter((block) => block.type === 'image')
      assert.equal(images.length, 1, summary)
      assert.equal(images[0].source.type, 'base64', summary)
      assert.ok(
        seen.some((block) => block.type === 'text' && block.text === 'SCREENSHOT'),
        summary,
      )
      // 没有换成“图存在某个文件里”的说明
      assert.doesNotMatch(summary, /\/(tmp|var|private|Users)\//, summary)
      const received = Buffer.from(images[0].source.data, 'base64')
      assert.equal(imageSize(received), `${side}x${side}`, summary)
      if (identical) {
        assert.equal(images[0].source.media_type, 'image/png', summary)
        assert.equal(images[0].source.data, data, '内容逐字相同')
      }
      model.assertConsumed()
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
