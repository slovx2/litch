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
  readTurns,
  runTurn,
  type Scene,
  startScene,
  uniqueSleep,
} from './fixtures/background-scene.mjs'
import { requiredClaudeCli } from './fixtures/claude-cli.mjs'
import { declaring } from './fixtures/extension-wire.mjs'
import { MockLLM, type ModelRequest } from './fixtures/mock-llm.mjs'

// Claude Code 默认给每个会话开本机收件箱（登记在 <配置目录>/sessions/<pid>.json，带 messagingSocketPath），
// 本机别处的 Claude 会话能用 ListAgents 看见、用 SendMessage 发进来并直接开回合。
// 设置里“接收别的 Claude 会话的消息”（CHA_CLAUDE_CROSS_SESSION_INBOX）默认开：入口让 CLI 一律直接投递、回显进模型的
// 用户消息，别的会话发来的画成带 litchPeer 的用户消息条目（peerMessages 扩展）。关着时入口给 CLI 设
// CLAUDE_CODE_HARBOR_KITE=0：这里用真实 CLI 断言它真的关上了，CLI 升级改了开关名时能及时发现。

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
// 它的模型先调 ListAgents，再用 SendMessage 发给 to。bypass 时它是跳过确认档（--dangerously-skip-permissions），
// CLI 不设 crossSessionInbound 时按档位扣住这种消息
async function peerSend(scene: Scene, to: string, bypass = false): Promise<PeerResult> {
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
        bypass ? 'peer-bypass' : 'peer-prompting',
        ...(bypass
          ? ['--dangerously-skip-permissions']
          : ['--allowedTools', 'SendMessage', 'ListAgents']),
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

test('设置里关掉时入口起的 CLI 不开本机收件箱：不登记套接字、模型没有 ListAgents、别处的会话发不进来', {
  timeout: 180_000,
}, async () => {
  const scene = await startScene('native-peer-inbox', { CHA_CLAUDE_CROSS_SESSION_INBOX: 'off' })
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

// 声明了扩展的连接多出我们的字段（会话上的 litchBackground、回合上的 litchOrigin、用户消息上的 litchPeer）：
// 校验上游结构时去掉
function standardView(method: string, _kind: string, payload: any): unknown {
  if (method.startsWith('litch/')) return undefined
  const copy = structuredClone(payload)
  const stripTurn = (turn: any) => {
    if (!turn || typeof turn !== 'object') return
    delete turn.litchOrigin
    for (const item of turn.items ?? []) delete item?.litchPeer
  }
  const stripThread = (thread: any) => {
    if (!thread || typeof thread !== 'object') return
    delete thread.litchBackground
    for (const turn of thread.turns ?? []) stripTurn(turn)
  }
  stripThread(copy?.thread)
  for (const entry of copy?.data ?? []) {
    stripThread(entry)
    stripTurn(entry)
  }
  stripTurn(copy?.turn)
  delete copy?.item?.litchPeer
  return copy
}

const turnsStarted = (scene: Scene): string[] =>
  scene.client.trace
    .filter((m: any) => m.method === 'turn/started')
    .map((m: any) => m.params.turn.id as string)

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`)
    await sleep(100)
  }
}

test('默认开着：跳过确认档的会话空闲时发来，自己开一个来历为 peer 的回合，开头是带 litchPeer 的消息', {
  timeout: 180_000,
}, async () => {
  const scene = await startScene(
    'native-peer-accept',
    {},
    declaring('peerMessages', 'backgroundTasks'),
  )
  scene.client.standardView = standardView
  try {
    let receiverTools: string[] = []
    const seen: string[] = []
    scene.model.enqueue((request, headers) => {
      receiverTools = peerTools(request)
      return backgroundBash('toolu_keep_alive', uniqueSleep(90))(request, headers)
    })
    scene.model.enqueue(() => [{ type: 'text', text: '已在后台启动' }])
    scene.model.fallback = (request) => {
      seen.push(JSON.stringify(request.messages?.at(-1)?.content ?? ''))
      return [{ type: 'text', text: '这是对外来消息的回答' }]
    }
    assert.equal((await runTurn(scene, '在后台起一条命令')).status, 'completed')
    assert.ok(
      receiverTools.includes('ListAgents'),
      `收件箱开着时模型应有 ListAgents：${receiverTools}`,
    )

    const [cli] = cliProcesses(scene)
    const mine = registry(scene).find((entry) => entry.pid === cli?.pid)
    assert.ok(mine?.messagingSocketPath, '收件箱开着时应登记套接字')

    const before = turnsStarted(scene).length
    const peer = await peerSend(scene, mine.name ?? String(cli?.pid), true)
    assert.equal(peer.ended, 'result')
    assert.ok(
      peer.listAgents.includes(mine.name ?? '\0'),
      `别处的 ListAgents 应列出它：${peer.listAgents}`,
    )
    await until('外来消息开回合', () => turnsStarted(scene).length > before)
    const turnId = turnsStarted(scene).at(-1)!
    const done = await scene.client.completed(turnId)
    assert.equal(done.status, 'completed')
    assert.equal(done.litchOrigin, 'peer', '回合来历应是 peer')
    assert.ok(
      seen.some((text) => text.includes('from-mode=\\"bypass\\"')),
      `模型应收到跳过确认档发来的消息：${seen}`,
    )

    const turn = (await readTurns(scene)).find((candidate) => candidate.id === turnId)
    const [first, ...rest] = turn.items
    assert.equal(first.type, 'userMessage')
    assert.deepEqual(first.content, [
      { type: 'text', text: '我是另一个 Claude 会话，请回复 hello', text_elements: [] },
    ])
    assert.deepEqual(first.litchPeer, { name: 'peer-bypass', mode: 'bypass' })
    assert.ok(
      rest.some(
        (item: any) => item.type === 'agentMessage' && item.text === '这是对外来消息的回答',
      ),
    )
    // 实时的条目通知也带着
    const live = scene.client.trace.find(
      (m: any) => m.method === 'item/completed' && m.params.item.id === first.id,
    )
    assert.deepEqual(live?.params.item.litchPeer, first.litchPeer)
    // 自己发的话的回显不重复出条目
    const firstTurn = (await readTurns(scene))[0]
    assert.equal(firstTurn.items.filter((item: any) => item.type === 'userMessage').length, 1)
  } finally {
    await disposeScene(scene)
  }
})

test('回合进行中发来的插进当前回合；没声明 peerMessages 的连接看到的是普通用户消息', {
  timeout: 180_000,
}, async () => {
  const scene = await startScene('native-peer-midturn')
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    scene.model.enqueue(async () => {
      await held
      return [{ type: 'text', text: '第一段回答' }]
    })
    scene.model.fallback = () => [{ type: 'text', text: '这是对外来消息的回答' }]
    const { turn } = await scene.client.request('turn/start', {
      threadId: scene.threadId,
      input: [{ type: 'text', text: '用户的第一句话' }],
    })
    await until('模型请求到达', () => scene.model.requests.length === 1)
    const [cli] = cliProcesses(scene)
    const mine = registry(scene).find((entry) => entry.pid === cli?.pid)
    assert.ok(mine?.messagingSocketPath)
    const peer = await peerSend(scene, mine.name ?? String(cli?.pid))
    assert.equal(peer.ended, 'result')
    release()
    const done = await scene.client.completed(turn.id)
    assert.equal(done.status, 'completed')
    assert.equal(turnsStarted(scene).length, 1, '不该另开回合')

    const [only] = await readTurns(scene)
    const users = only.items.filter((item: any) => item.type === 'userMessage')
    assert.equal(users.length, 2, `回合里应有自己的话和外来的消息：${JSON.stringify(only.items)}`)
    assert.equal(users[1].content[0].text, '我是另一个 Claude 会话，请回复 hello')
    assert.ok(!('litchPeer' in users[1]), '没声明的连接上不该有 litchPeer')
    const texts = only.items
      .filter((item: any) => item.type === 'agentMessage')
      .map((i: any) => i.text)
    assert.deepEqual(texts, ['第一段回答', '这是对外来消息的回答'])
    const order = only.items.map((item: any) => item.type)
    assert.ok(
      order.indexOf('agentMessage') < order.lastIndexOf('userMessage'),
      `外来消息应排在第一段回答之后：${order}`,
    )
  } finally {
    release()
    await disposeScene(scene)
  }
})

test('默认开着：没有后台命令的会话空闲保留着也收得到；登记名是会话名，改名后跟着换', {
  timeout: 180_000,
}, async () => {
  const scene = await startScene(
    'native-peer-idle',
    {},
    declaring('peerMessages', 'backgroundTasks'),
  )
  try {
    await scene.client.request('thread/name/set', { threadId: scene.threadId, name: '修 CI' })
    scene.model.enqueue(() => [{ type: 'text', text: '好的' }])
    scene.model.fallback = () => [{ type: 'text', text: '这是对外来消息的回答' }]
    assert.equal((await runTurn(scene, '说一句')).status, 'completed')

    const [cli] = cliProcesses(scene)
    assert.ok(cli, '没有后台命令，空闲保留（开着收件箱默认 1 小时）也把 CLI 留下')
    const entry = () => registry(scene).find((candidate) => candidate.pid === cli.pid)
    assert.equal(entry()?.name, '修 CI', '收件箱登记名应是会话名')

    await scene.client.request('thread/name/set', {
      threadId: scene.threadId,
      name: '修 CI 流水线',
    })
    await until('登记名跟着改名', () => entry()?.name === '修 CI 流水线')

    const before = turnsStarted(scene).length
    const peer = await peerSend(scene, '修 CI 流水线')
    assert.equal(peer.ended, 'result')
    assert.ok(peer.listAgents.includes('修 CI 流水线'), `别处应按新名字看到它：${peer.listAgents}`)
    await until('外来消息开回合', () => turnsStarted(scene).length > before)
    const done = await scene.client.completed(turnsStarted(scene).at(-1)!)
    assert.equal(done.status, 'completed')
    assert.equal(done.litchOrigin, 'peer')
    assert.equal(cliProcesses(scene)[0]?.pid, cli.pid, '用的是留着的同一个进程')
  } finally {
    await disposeScene(scene)
  }
})
