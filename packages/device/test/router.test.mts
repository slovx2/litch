import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceServer } from '../src/device.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import {
  assertErrorData,
  assertRuntimeInfo,
  assertThreadList,
  errorCode,
  rig,
  settle,
  TestClient,
} from './helpers.mjs'

const threads = (prefix: string, times: number[]) =>
  times.map((updatedAt, index) => ({ id: `${prefix}${index + 1}`, updatedAt, cwd: '/work' }))

test('握手：没声明 harness 扩展的被拒绝并说明原因，声明了的握手成功', async () => {
  const pi = new FakeUpstream('pi')
  const env = rig({ pi })
  try {
    const plain = env.connect()
    // 握手之前别的请求都不行
    assert.equal((await plain.fails('runtime/info')).message, 'Not initialized')
    const refused = await plain.fails('initialize', {
      clientInfo: { name: 'codex-app', title: null, version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    assert.equal(refused.code, errorCode('extensionRequired'))
    assert.match(refused.message, /capabilities\.litchExtensions/)
    assert.match(refused.message, /harness/)
    assert.deepEqual(refused.data, {
      litch: 'extensionRequired',
      required: ['harness'],
      supported: [
        'harness',
        'deviceWorkspaces',
        'filePreview',
        'turnRecovery',
        'deviceProcesses',
        'harnessConfig',
        'clientApprovals',
        'deviceTasks',
        // 测试机上有 git
        'worktrees',
        'sessionTree',
        'sessionQuestionIgnore',
      ],
    })
    assertErrorData(refused.data)
    // 被拒绝的连接没有连任何上游，也还是未初始化
    assert.equal(pi.connections.length, 0)
    assert.equal((await plain.fails('thread/list', {})).message, 'Not initialized')
    // 列了别的扩展、唯独没有 harness，一样不行
    assert.equal(
      (
        await plain.fails('initialize', {
          capabilities: { litchExtensions: ['somethingElse'] },
        })
      ).data.litch,
      'extensionRequired',
    )

    const client = env.connect()
    const result = await client.initialize(['harness', 'futureThing'], {
      optOutNotificationMethods: ['thread/started'],
      subAgentActivityKinds: ['completed'],
    })
    assert.deepEqual(Object.keys(result).sort(), [
      'codexHome',
      'platformFamily',
      'platformOs',
      'userAgent',
    ])
    assert.equal(result.codexHome, env.stateDir)
    assert.match(result.userAgent, /^device-test\/0\.163\.0 .*codex-harness-adapter-device/)
    // 握手应答是客户端收到的第一帧
    assert.equal(JSON.parse(client.raw[0] ?? '{}').result?.userAgent, result.userAgent)
    // 客户端声明的能力带给了上游，包括它认识哪些扩展；退订名单不带，那是聚合面自己拦的。
    // 设备进程自己执行的命名空间（litch_tasks、litch_sessions）替这条连接声明上（客户端工具的扩展跟着加上）
    const upstream = pi.seen.find((entry) => entry.method === 'initialize')
    assert.deepEqual(upstream?.params, {
      clientInfo: { name: 'device-test', title: null, version: '0.0.1' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        litchExtensions: ['harness', 'futureThing', 'clientTools'],
        subAgentActivityKinds: ['completed'],
        litchClientTools: {
          namespaces: ['litch_tasks', 'litch_sessions'],
          anyThread: ['litch_tasks', 'litch_sessions'],
        },
      },
    })
    assert.ok(pi.seen.some((entry) => entry.method === 'initialized' && entry.id === undefined))
    assert.equal((await client.fails('initialize', {})).message, 'Already initialized')
  } finally {
    await env.close()
  }
})

test('一条客户端连接对应一组上游连接，客户端断开时这组上游一起断', async () => {
  const pi = new FakeUpstream('pi')
  const claude = new FakeUpstream('claude-code')
  const env = rig({ pi, 'claude-code': claude })
  try {
    const first = env.connect()
    const second = env.connect()
    await first.initialize()
    await second.initialize()
    assert.equal(pi.live.length, 2)
    assert.equal(claude.live.length, 2)
    assert.equal(env.device.connections, 2)
    first.close()
    await settle()
    // 剩下的是另一条客户端的，加上设备进程自己留的一条（引擎自己开的回合里设备工具要有执行方）
    assert.equal(pi.live.length, 2)
    assert.equal(claude.live.length, 2)
    assert.equal(pi.live.filter((one) => one.raw[0]?.includes(`"name":"litch-device"`)).length, 1)
    assert.equal(env.device.connections, 1)
    // 剩下的那条不受影响
    assert.equal((await second.call('runtime/info')).harnesses.length, 2)
  } finally {
    await env.close()
  }
})

test('runtime/info：设备信息和每个 harness 的状态，形状和扩展定义一致', async () => {
  const pi = new FakeUpstream('pi')
  pi.version = '0.99.1'
  const codex = new FakeUpstream(null)
  const missing = new FakeUpstream('dsh')
  missing.down = true
  // 引擎在自己的 runtime/info 里报的结构化声明，聚合面原样带到这个 harness 上
  const declaration = {
    displayName: 'Pi',
    badge: 'PI',
    extensions: [],
    features: { steer: true, approvals: { kinds: [], uncovered: [] }, inputTypes: ['text'] },
    permissionPresets: [{ id: ':danger-full-access', risk: 'high', requiresConfirmation: false }],
  }
  pi.declaration = declaration
  const lines: string[] = []
  const env = rig({ pi, codex, dsh: missing }, {}, { log: (line) => lines.push(line) })
  try {
    const client = env.connect()
    await client.initialize()
    const info = await client.call('runtime/info', {})
    assertRuntimeInfo(info)
    assert.equal(info.device.version, '9.9.9')
    assert.equal(info.device.protocolVersion, '0.163.0')
    assert.deepEqual(info.device.extensions, [
      'harness',
      'deviceWorkspaces',
      'filePreview',
      'turnRecovery',
      'deviceProcesses',
      'harnessConfig',
      'clientApprovals',
      'deviceTasks',
      'worktrees',
      'sessionTree',
      'sessionQuestionIgnore',
    ])
    assert.ok(info.device.hostname && info.device.home && info.device.os)
    assert.deepEqual(info.harnesses, [
      {
        id: 'pi',
        displayName: 'Pi',
        badge: 'PI',
        version: '0.99.1',
        engine: 'pi',
        available: true,
        unavailable: null,
        // 声明里的这三项原样带过来；显示名和徽标已经用在上面了
        extensions: declaration.extensions,
        features: declaration.features,
        permissionPresets: declaration.permissionPresets,
      },
      {
        // 没报声明的（原生 codex）没有这三项
        id: 'codex',
        displayName: 'Codex',
        badge: 'CX',
        version: '9.8.7',
        engine: null,
        available: true,
        unavailable: null,
      },
      {
        id: 'dsh',
        // 没连上过的 harness 用仓库里登记的名字，和引擎自报的、设置里那一组的标题是同一个出处
        displayName: 'DSH',
        badge: 'DS',
        version: null,
        engine: null,
        available: false,
        unavailable: {
          kind: 'unreachable',
          message: '连不上这个运行时：它的套接字不在，多半是还没有启动',
        },
      },
    ])
    // 给人看的那句不带套接字的路径（会原样显示在界面上）；系统给的原文在设备进程的日志里
    assert.ok(!JSON.stringify(info).includes('runtime.sock'))
    assert.ok(
      lines.some(
        (line) => line.includes('dsh 不可用') && line.includes('/fake/state/dsh/runtime.sock'),
      ),
      lines.join('\n'),
    )
  } finally {
    await env.close()
  }
})

test('路由：按会话归属、按 harness 参数、不认识的会话问一遍、不支持的明确报错', async () => {
  const pi = new FakeUpstream('pi', threads('p', [50, 30]))
  const claude = new FakeUpstream('claude-code', threads('c', [40]))
  const env = rig({ pi, 'claude-code': claude })
  try {
    const client = env.connect()
    await client.initialize()

    // 不认识的会话：向各上游问一遍，转给认识它的那个，并记下来
    const before = claude.seen.length
    const turn = await client.call('turn/start', { threadId: 'c1', input: [] })
    assert.equal(turn.turn.id, 'turn-of-c1')
    assert.deepEqual(
      claude.seen.slice(before).map((entry) => entry.method),
      ['thread/read', 'turn/start'],
    )
    assert.deepEqual(claude.seen.at(-2)?.params, { threadId: 'c1', includeTurns: false })
    assert.ok(!pi.seen.some((entry) => entry.method === 'turn/start'))
    // 第二次不用再问
    await client.call('turn/start', { threadId: 'c1', input: [] })
    assert.equal(claude.seen.filter((entry) => entry.method === 'thread/read').length, 1)
    // 没改动的请求是原样转发的：上游收到的原文就是客户端发的原文
    const original = JSON.stringify({
      id: 'r-1',
      method: 'turn/start',
      params: { threadId: 'c1', input: [], 'k y': 1 },
    })
    client.sendRaw(original)
    await settle()
    assert.equal(claude.live[0]?.raw.at(-1), original)

    // 哪个上游都不认识的会话
    const unknown = await client.fails('turn/start', { threadId: 'nobody', input: [] })
    assert.equal(unknown.code, errorCode('unknownThread'))
    assert.deepEqual(unknown.data, { litch: 'unknownThread', threadId: 'nobody', unavailable: [] })

    // 带 harness 的转给对应上游，转之前把 harness 摘掉
    const models = await client.call('model/list', { harness: 'pi', limit: 5 })
    assert.deepEqual(models.data, [{ id: 'pi-model' }])
    assert.equal(pi.seen.at(-1)?.method, 'model/list')
    assert.deepEqual(pi.seen.at(-1)?.params, { limit: 5 })
    assert.ok(!claude.seen.some((entry) => entry.method === 'model/list'))

    // 新建会话：应答里的会话对象打上 harness，标识进了索引，之后带会话标识的请求不用再问
    const started = await client.call('thread/start', { harness: 'claude-code', cwd: '/work' })
    assert.equal(started.thread.harness, 'claude-code')
    assert.deepEqual(claude.seen.at(-1)?.params, { cwd: '/work' })
    const reads = claude.seen.filter((entry) => entry.method === 'thread/read').length
    await client.call('turn/start', { threadId: started.thread.id, input: [] })
    assert.equal(claude.seen.filter((entry) => entry.method === 'thread/read').length, reads)
    // 上游回的错误原样带回来，没有聚合面的标记
    const upstreamError = await client.fails('review/start', { threadId: 'c1' })
    assert.deepEqual(upstreamError, { code: -32601, message: '不支持 review/start' })

    // 没配置的 harness
    const stranger = await client.fails('model/list', { harness: 'nope' })
    assert.equal(stranger.code, errorCode('unknownHarness'))
    assert.deepEqual(stranger.data, { litch: 'unknownHarness', harness: 'nope' })

    // 聚合面不支持的
    for (const [method, params] of [
      ['model/list', {}],
      ['command/exec', { command: ['true'] }],
      ['project/somethingElse', { harness: 'pi' }],
      ['threadSection/reorder', {}],
    ] as const) {
      const failure = await client.fails(method, params)
      assert.equal(failure.code, errorCode('unsupported'), method)
      assert.equal(failure.code, -32601)
      assert.match(failure.message, new RegExp(`^聚合面不支持 ${method}`))
      assert.deepEqual(failure.data, { litch: 'unsupported', method })
      assertErrorData(failure.data)
    }
    assert.ok(!pi.seen.some((entry) => entry.method.startsWith('project/')))
  } finally {
    await env.close()
  }
})

test('会话列表：合并各上游、打上 harness、能翻页、记进索引，重启后索引还在', async () => {
  const pi = new FakeUpstream('pi', threads('p', [90, 70, 50]))
  const claude = new FakeUpstream('claude-code', threads('c', [80, 60]))
  claude.threads.push({ id: 'c-archived', updatedAt: 99, archived: true })
  const env = rig({ pi, 'claude-code': claude })
  try {
    const client = env.connect()
    await client.initialize()
    const all = await client.call('thread/list', {})
    assertThreadList(all)
    assert.deepEqual(
      all.data.map((thread: any) => `${thread.id}@${thread.harness}`),
      ['p1@pi', 'c1@claude-code', 'p2@pi', 'c2@claude-code', 'p3@pi'],
    )
    assert.equal(all.data[0].cwd, '/work')
    assert.deepEqual([all.nextCursor, all.backwardsCursor, all.skippedHarnesses], [null, null, []])
    // 排序和页大小由聚合面定；别的筛选条件原样交给上游
    await client.call('thread/list', {
      archived: true,
      limit: 7,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    })
    assert.deepEqual(claude.seen.at(-1)?.params, {
      archived: true,
      limit: 7,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    })

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: any = await client.call('thread/list', { limit: 2, cursor })
      seen.push(...page.data.map((thread: any) => thread.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(seen, ['p1', 'c1', 'p2', 'c2', 'p3'])

    // 只列一个 harness 的
    const only = await client.call('thread/list', { harness: 'claude-code' })
    assert.deepEqual(
      only.data.map((thread: any) => thread.id),
      ['c1', 'c2'],
    )
    // 只支持按更新时间倒序
    assert.equal((await client.fails('thread/list', { sortKey: 'created_at' })).code, -32602)
    assert.equal((await client.fails('thread/list', { sortDirection: 'asc' })).code, -32602)
    assert.equal((await client.fails('thread/list', { cursor: 'garbage' })).code, -32602)
    assert.equal((await client.fails('thread/list', { limit: 0 })).code, -32602)

    // 列表里见过的会话不用再向上游打听
    await client.call('turn/start', { threadId: 'p2', input: [] })
    assert.ok(!pi.seen.some((entry) => entry.method === 'thread/read'))
    assert.ok(!claude.seen.some((entry) => entry.method === 'thread/read'))

    // 索引落在状态目录的库里：换一个设备进程（同一个状态目录）还认得
    await env.device.close()
    const again = new DeviceServer({
      importExisting: false,
      stateDir: env.stateDir,
      upstreams: [
        { id: 'pi', connect: pi.connector },
        { id: 'claude-code', connect: claude.connector },
      ],
    })
    const later = new TestClient(again)
    await later.initialize()
    await later.call('turn/start', { threadId: 'c2', input: [] })
    assert.ok(!pi.seen.some((entry) => entry.method === 'thread/read'))
    assert.ok(!claude.seen.some((entry) => entry.method === 'thread/read'))
    await again.close()
  } finally {
    await env.close().catch(() => {})
  }
})
