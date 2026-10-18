import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer } from '../../shared/src/types.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate, violations } from './client.mjs'

// 一个会话多个订阅连接：通知每条订阅连接都收到；审批发给全部订阅连接，
// 请求号相同，先答的生效，其余连接收到 serverRequest/resolved，迟到的应答被丢弃。

interface Recorder extends RpcPeer {
  messages: any[]
  requests(): any[]
  resolved(): any[]
}

function recorder(id: string): Recorder {
  const messages: any[] = []
  return {
    id,
    messages,
    close() {},
    send(message) {
      messages.push(message)
    },
    requests: () => messages.filter((m) => m.method && m.id !== undefined),
    resolved: () => messages.filter((m) => m.method === 'serverRequest/resolved'),
  }
}

// 只测请求的分发：不启动 dsh 进程。
async function scene(run: (server: DshServer) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-multi-')))
  const server = new DshServer(join(root, 'home'))
  try {
    await run(server)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

function attach(server: DshServer, threadId: string, ...peers: RpcPeer[]): void {
  for (const peer of peers) {
    server.peers.set(peer.id, peer)
    server.subscribe(peer, threadId)
  }
}

const METHOD = 'item/commandExecution/requestApproval'
const approval = { command: 'echo hi', availableDecisions: ['accept', 'decline', 'cancel'] }
const decide = (id: unknown, decision: string) =>
  ({ jsonrpc: '2.0', id, result: { decision } }) as any

test('MULTI-DSH-001：审批发给全部订阅连接，先答的生效，其余收到已解决，迟到的应答丢弃', async () => {
  await scene(async (server) => {
    const first = recorder('first')
    const second = recorder('second')
    attach(server, 't', first, second)
    const asked = server.call('t', METHOD, approval)
    assert.equal(first.requests().length, 1)
    assert.deepEqual(second.requests(), first.requests(), '两条连接收到同一条请求，请求号相同')
    const request = first.requests()[0]

    await server.handle(second, decide(request.id, 'accept'))
    assert.deepEqual(await asked, { decision: 'accept' })
    for (const peer of [first, second])
      assert.deepEqual(
        peer.resolved().map((m) => m.params),
        [{ threadId: 't', requestId: request.id }],
        `${peer.id} 收到一次已解决`,
      )
    const before = [first.messages.length, second.messages.length]
    await server.handle(first, decide(request.id, 'decline'))
    assert.deepEqual([first.messages.length, second.messages.length], before, '迟到的应答不起作用')
  })
})

test('MULTI-DSH-002：断开一条连接，请求留给还在的那条；全都断开才按“客户端已断开”结束', async () => {
  for (const leaving of ['first', 'second'] as const)
    await scene(async (server) => {
      const peers = { first: recorder('first'), second: recorder('second') }
      attach(server, 't', peers.first, peers.second)
      const staying = peers[leaving === 'first' ? 'second' : 'first']
      const asked = server.call('t', METHOD, approval)
      const request = staying.requests()[0]
      server.closePeer(peers[leaving])
      assert.equal(staying.resolved().length, 0, '还有连接拿着请求，不能当作已经有结果')
      await server.handle(staying, decide(request.id, 'accept'))
      assert.deepEqual(await asked, { decision: 'accept' })
      assert.equal(staying.resolved().length, 1)
    })
  await scene(async (server) => {
    const first = recorder('first')
    const second = recorder('second')
    attach(server, 't', first, second)
    const asked = server.call('t', METHOD, approval)
    server.closePeer(first)
    server.closePeer(second)
    await assert.rejects(asked, /客户端已断开/)
    await assert.rejects(server.call('t', METHOD, approval), /没有可处理交互的已连接客户端/)
  })
})

test('MULTI-DSH-003：后来才订阅的连接补收到还在等的审批；只有一条连接时往来和以前逐条相同', async () => {
  await scene(async (server) => {
    const only = recorder('only')
    attach(server, 't', only)
    const asked = server.call('t', METHOD, approval)
    const request = only.requests()[0]
    assert.deepEqual(only.messages, [
      {
        jsonrpc: '2.0',
        id: request.id,
        method: METHOD,
        params: { threadId: 't', turnId: '', itemId: request.id, ...approval },
      },
    ])

    const late = recorder('late')
    attach(server, 't', late)
    // 补送发生在订阅它的那个请求应答之后；这里用一个无关的请求走一遍应答路径。
    await server.handle(late, { jsonrpc: '2.0', id: 1, method: 'thread/loaded/list', params: {} })
    assert.deepEqual(late.requests(), [request], '请求号与内容不变')
    assert.equal(only.messages.length, 1, '已经拿着的连接不重复收，也不被告知撤回')

    await server.handle(only, decide(request.id, 'decline'))
    assert.deepEqual(await asked, { decision: 'decline' })
    assert.deepEqual(only.messages.slice(1), [
      { method: 'serverRequest/resolved', params: { threadId: 't', requestId: request.id } },
    ])
    assert.equal(late.resolved().length, 1)
  })
})

// 上游发给所有连接的会话级通知（rust-v0.162.0-alpha.20 里经全局的 OutgoingMessageSender 发的那些），
// 没订阅、没读过这个会话的连接也靠它们跟着别处的会话变（侧栏上的状态记号、名字、归档）。
// 回合、条目、设置、用量、队列、服务端请求的结果只给订阅者。这里写成字面的，不引用实现里的那一份。
const EVERYONE = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/name/updated',
  'thread/archived',
  'thread/unarchived',
  'thread/closed',
  'thread/deleted',
  'thread/reverted',
  'thread/project/updated',
  'thread/attachment/updated',
])
const about = (entry: any): string | undefined => entry.params?.threadId ?? entry.params?.thread?.id

const waitFor = async (what: string, ready: () => boolean): Promise<void> => {
  for (let waited = 0; waited < 20000; waited += 20) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时: ${what}`)
}

test('MULTI-DSH-004：真实 dsh 上两条连接同看一个会话：通知逐条相同，审批两边都到，退订后只剩一边', {
  timeout: 120000,
}, async () => {
  const env = await isolate([
    [
      {
        type: 'tool_use',
        name: 'bash',
        input: {
          command: 'echo approved',
          description: '需要提权的命令',
          sandbox_permissions: 'danger-full-access',
          justification: '测试两条连接的审批。',
        },
      },
    ],
    [{ type: 'text', chunks: ['第一轮完成。'] }],
    [{ type: 'text', chunks: ['第二轮完成。'] }],
  ])
  const server = new DshServer(join(env.root, 'home'))
  try {
    const desktop = client(server)
    const mobile = client(server)
    for (const each of [desktop, mobile]) {
      await each.call('initialize', { clientInfo: { name: 'test', version: '0' } })
      each.onRequest(() => undefined)
    }
    const { thread } = await desktop.call('thread/start', {
      cwd: env.cwd,
      permissions: ':workspace',
    })
    await mobile.call('thread/resume', { threadId: thread.id })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const mark = { desktop: desktop.notifications.length, mobile: mobile.notifications.length }

    const { turn } = await desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '执行需要提权的命令。' }],
    })
    await waitFor(
      '两条连接都收到审批',
      () => desktop.requests.length + mobile.requests.length === 2,
    )
    assert.deepEqual(mobile.requests, desktop.requests, '同一条请求，请求号相同')
    const request = mobile.requests[0]
    assert.equal(request.method, METHOD)

    // 没发起回合的那条连接先答：命令照常执行。
    await mobile.respond(request, { decision: 'accept' })
    const done = await desktop.until('turn/completed', (params) => params.turn.id === turn.id)
    await mobile.until('turn/completed', (params) => params.turn.id === turn.id)
    await desktop.respond(request, { decision: 'decline' })
    const command = done.turn.items.find((item: any) => item.type === 'commandExecution')
    assert.equal(command.status, 'completed', '迟到的拒绝不起作用')
    assert.match(command.aggregatedOutput, /approved/)
    assert.deepEqual(
      mobile.notifications.slice(mark.mobile),
      desktop.notifications.slice(mark.desktop),
      '同一个回合的通知两条连接逐条相同',
    )
    for (const each of [desktop, mobile])
      assert.equal(
        each.notifications.filter((entry) => entry.method === 'serverRequest/resolved').length,
        1,
      )

    // 一条连接退订：它不再收到，另一条照常。
    assert.deepEqual(await mobile.call('thread/unsubscribe', { threadId: thread.id }), {
      status: 'unsubscribed',
    })
    const quiet = mobile.notifications.length
    const next = await desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '再说一句。' }],
    })
    const second = await desktop.until(
      'turn/completed',
      (params) => params.turn.id === next.turn.id,
    )
    assert.equal(second.turn.status, 'completed')
    // 会话级的那几种（状态变了）和上游一样照样发给退订了的连接，回合和条目的不再给它
    const after = mobile.notifications.slice(quiet).map((entry) => entry.method)
    assert.ok(after.includes('thread/status/changed'), `${after}`)
    assert.deepEqual(
      after.filter((method) => !EVERYONE.has(method)),
      [],
      '退订之后不再收到回合和条目的通知',
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})

// 上游的 thread/read 只读不订阅（带不带 includeTurns 都一样），订阅靠 thread/start、thread/resume 这些。
// 官方桌面端找一个置顶会话在哪台机器上时，拿会话号向每个入口都读一遍：读一下就订阅的话，这条连接之后平白收这个会话的全部通知。
test('MULTI-DSH-005：只 thread/read 过的连接不算订阅，收不到回合和条目的通知，thread/resume 过的照收', {
  timeout: 120000,
}, async () => {
  const env = await isolate([[{ type: 'text', chunks: ['读和订阅。'] }]])
  const server = new DshServer(join(env.root, 'home'))
  try {
    const owner = client(server)
    const reader = client(server)
    const resumer = client(server)
    for (const each of [owner, reader, resumer])
      await each.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await owner.call('thread/start', { cwd: env.cwd })
    for (const includeTurns of [true, false])
      assert.equal(
        (await reader.call('thread/read', { threadId: thread.id, includeTurns })).thread.id,
        thread.id,
      )
    await resumer.call('thread/resume', { threadId: thread.id })
    const quiet = reader.notifications.length
    const { turn } = await owner.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '说一句。' }],
    })
    for (const each of [owner, resumer])
      await each.until('turn/completed', (params) => params.turn.id === turn.id)
    // 会话级的那几种（状态变了、起了名字）发给所有连接，回合和条目的不给它
    const read = reader.notifications.slice(quiet).map((entry) => entry.method)
    assert.ok(read.includes('thread/status/changed'), `${read}`)
    assert.deepEqual(
      read.filter((method) => !EVERYONE.has(method)),
      [],
      '只读过的连接不该收到回合和条目的通知',
    )
    assert.deepEqual(await reader.call('thread/unsubscribe', { threadId: thread.id }), {
      status: 'notSubscribed',
    })
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})

test('MULTI-DSH-006：没订阅、没读过的连接照样收到会话的新建、状态、改名、归档，收不到回合和条目；临时会话的不给它', {
  timeout: 120000,
}, async () => {
  const env = await isolate([[{ type: 'text', chunks: ['别处在跑。'] }]])
  const server = new DshServer(join(env.root, 'home'))
  try {
    const owner = client(server)
    const bystander = client(server)
    for (const each of [owner, bystander])
      await each.call('initialize', { clientInfo: { name: 'test', version: '0' } })
    const { thread } = await owner.call('thread/start', { cwd: env.cwd })
    await bystander.until('thread/started', (params) => params.thread.id === thread.id)
    const { turn } = await owner.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '说一句。' }],
    })
    await owner.until('turn/completed', (params) => params.turn.id === turn.id)
    await owner.call('thread/name/set', { threadId: thread.id, name: '别处改的名字' })
    await owner.call('thread/archive', { threadId: thread.id })
    await owner.call('thread/unarchive', { threadId: thread.id })
    // 临时会话（官方桌面端起标题用的）不进列表，它的通知只给建它的连接
    const helper = (await owner.call('thread/start', { cwd: env.cwd, ephemeral: true })).thread
    await owner.until('thread/started', (params) => params.thread.id === helper.id)
    await bystander.until('thread/unarchived', (params) => params.threadId === thread.id)
    const seen = bystander.notifications.filter((entry) => about(entry) === thread.id)
    for (const entry of seen)
      assert.ok(EVERYONE.has(entry.method), `没订阅的连接不该收到 ${entry.method}`)
    const statuses = seen
      .filter((entry) => entry.method === 'thread/status/changed')
      .map((entry) => entry.params.status.type)
    assert.ok(statuses.includes('active') && statuses.at(-1) === 'idle', `状态：${statuses}`)
    assert.ok(
      seen.some(
        (entry) =>
          entry.method === 'thread/name/updated' && entry.params.threadName === '别处改的名字',
      ),
      '改名',
    )
    for (const method of ['thread/archived', 'thread/unarchived'])
      assert.equal(seen.filter((entry) => entry.method === method).length, 1, method)
    assert.deepEqual(
      bystander.notifications.filter((entry) => about(entry) === helper.id),
      [],
      '临时会话的通知不给别的连接',
    )
    assert.deepEqual([...violations], [], '往来消息必须符合协议 schema')
  } finally {
    await server.close()
    await env.restore()
  }
})
