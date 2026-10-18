import assert from 'node:assert/strict'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import {
  backgroundBash,
  cliProcesses,
  disposeScene,
  runTurn,
  type Scene,
  startScene,
  uniqueSleep,
} from './fixtures/background-scene.mjs'
import { requiredClaudeCli } from './fixtures/claude-cli.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'

// Claude Code 默认给每个会话开本机收件箱（登记在 <配置目录>/sessions/<pid>.json，带 messagingSocketPath），
// 本机别处的 Claude 会话能用 ListAgents 看见、用 SendMessage 发进来并直接开回合。
// 入口给 CLI 设了 CLAUDE_CODE_HARBOR_KITE=0：这里用真实 CLI 断言它真的关上了，CLI 升级改了开关名时能及时发现。

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface RegistryEntry {
  pid: number
  name?: string
  messagingSocketPath?: string | null
}

function registry(scene: Scene): RegistryEntry[] {
  const dir = join(scene.home, 'claude', 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')))
}

const peerTools = (request: ModelRequest): string[] =>
  (request.tools ?? [])
    .map((tool: any) => tool.name)
    .filter((name: string) => /Agent|Message/.test(name))

function toolResult(request: ModelRequest, id: string): string {
  for (const message of request.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    const block = message.content.find(
      (entry: any) => entry.type === 'tool_result' && entry.tool_use_id === id,
    )
    if (block)
      return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
  }
  return ''
}

interface PeerResult {
  ended: string
  listAgents: string
  send: string
  // 发送方自己活着时的登记：用来确认这个版本的 CLI 默认确实开收件箱
  peerEntry: RegistryEntry | undefined
}

// 像用户在终端或桌面端开的另一个 Claude 会话：同一个配置目录，收件箱按 CLI 默认开着。
// 它的模型先调 ListAgents，再用 SendMessage 发给 to。
async function peerSend(scene: Scene, to: string): Promise<PeerResult> {
  const model = new MockLLM()
  const result: PeerResult = { ended: '', listAgents: '', send: '', peerEntry: undefined }
  let child: ChildProcessWithoutNullStreams | undefined
  model.enqueue(() => [{ type: 'tool_use', id: 'toolu_peer_list', name: 'ListAgents', input: {} }])
  model.enqueue((request) => {
    result.listAgents = toolResult(request, 'toolu_peer_list')
    result.peerEntry = registry(scene).find((entry) => entry.pid === child?.pid)
    return [
      {
        type: 'tool_use',
        id: 'toolu_peer_send',
        name: 'SendMessage',
        input: { to, summary: '探针', message: '我是另一个 Claude 会话，请回复 hello' },
      },
    ]
  })
  model.enqueue((request) => {
    result.send = toolResult(request, 'toolu_peer_send')
    return [{ type: 'text', text: '发完了' }]
  })
  model.fallback = () => [{ type: 'text', text: '多余的请求' }]
  const url = await model.start()
  try {
    const proc = spawn(
      requiredClaudeCli(),
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '-n',
        'peer-prompting',
        '--allowedTools',
        'SendMessage',
        'ListAgents',
      ],
      {
        cwd: scene.workspace,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: scene.home,
          TMPDIR: scene.home,
          CLAUDE_CONFIG_DIR: join(scene.home, 'claude'),
          CLAUDE_CODE_TMPDIR: join(scene.home, 'ct'),
          ANTHROPIC_API_KEY: 'test-not-a-secret',
          ANTHROPIC_BASE_URL: url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
        },
      },
    )
    child = proc
    const ended = new Promise<string>((resolve) => {
      createInterface({ input: proc.stdout }).on('line', (line) => {
        try {
          if (JSON.parse(line).type === 'result') resolve('result')
        } catch {}
      })
      proc.once('close', () => resolve('closed'))
    })
    proc.stdin.write(
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: '发消息' } })}\n`,
    )
    result.ended = await Promise.race([ended, sleep(60_000).then(() => 'timeout')])
    return result
  } finally {
    child?.kill('SIGTERM')
    await model.close()
  }
}

test('入口起的 CLI 不开本机收件箱：不登记套接字、模型没有 ListAgents、别处的会话发不进来', {
  timeout: 180_000,
}, async () => {
  const scene = await startScene('native-peer-inbox')
  try {
    let receiverTools: string[] = []
    // 后台命令把进程留在回合之外：这正是外来消息能自己开回合的窗口。
    scene.model.enqueue((request, headers) => {
      receiverTools = peerTools(request)
      return backgroundBash('toolu_keep_alive', uniqueSleep(90))(request, headers)
    })
    scene.model.enqueue(() => [{ type: 'text', text: '已在后台启动' }])
    let extraRequests = 0
    scene.model.fallback = () => {
      extraRequests += 1
      return [{ type: 'text', text: '这是对外来消息的回答' }]
    }
    assert.equal((await runTurn(scene, '在后台起一条命令')).status, 'completed')

    const [cli] = cliProcesses(scene)
    assert.ok(cli, '后台命令在跑，CLI 进程应当留着')
    assert.ok(receiverTools.includes('SendMessage'), '子代理、teammate 用的 SendMessage 仍在')
    assert.ok(!receiverTools.includes('ListAgents'), `模型不该有 ListAgents：${receiverTools}`)

    const mine = registry(scene).find((entry) => entry.pid === cli.pid)
    assert.ok(mine, '会话登记仍在（CLI 照常写），只是没有收件箱')
    assert.ok(!mine.messagingSocketPath, `不该登记收件箱套接字：${mine.messagingSocketPath}`)

    const turnsBefore = scene.client.trace.filter((m) => m.method === 'turn/started').length
    const peer = await peerSend(scene, mine.name ?? String(cli.pid))
    assert.equal(peer.ended, 'result', '发送方应当正常结束')
    // 对照：同一个 CLI 不设开关时默认开收件箱，否则上面的断言证明不了什么
    assert.ok(
      peer.peerEntry?.messagingSocketPath,
      '发送方（CLI 默认设置）应当登记了收件箱；没有的话 CLI 的默认或开关名变了，要重新核对',
    )
    assert.ok(
      !peer.listAgents.includes(mine.name ?? '\0'),
      `别处的 ListAgents 不该列出这个会话：${peer.listAgents}`,
    )
    assert.match(peer.send, /not reachable|No agent/i, `SendMessage 应当当场失败：${peer.send}`)

    await sleep(3_000)
    const turnsAfter = scene.client.trace.filter((m) => m.method === 'turn/started').length
    assert.equal(turnsAfter, turnsBefore, '外来消息不该开回合')
    assert.equal(extraRequests, 0, '模型不该再收到请求')
  } finally {
    await disposeScene(scene)
  }
})
