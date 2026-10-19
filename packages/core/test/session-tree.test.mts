// 会话树：投影（注入的事件、子代理卡片、派出卡片、父子关系、只能看的子代理线程）、
// 完整模式的设备（声明、建会话带 litch_sessions、子代理线程不进侧栏、父子关系的通知、派出、提案、脱离），
// 以及模拟核心里的几出演示。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionEvent, type SessionProposal } from '../../protocol/src/index.mjs'
import {
  bucketItems,
  type ChannelError,
  cardOf,
  connectChannel,
  createMockCore,
  createPortPair,
  reduceSession,
  type SessionOp,
  type SessionProposalView,
  type SessionSummary,
  type SessionView,
  type SidebarOp,
  type SidebarView,
  serveChannel,
  type ToolCallItem,
  type UserMessageItem,
} from '../src/index.mjs'
import { projectItem } from '../src/projection/items.mjs'
import { projectLineage, projectThread } from '../src/projection/session.mjs'
import { projectProposals } from '../src/projection/tree.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread, turn, userText } from './fixtures.mjs'
import { fakeClock, settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

const NOW = 1_700_000_000_000

test('投影：开头是 <litch-session-event> 的用户消息拆成事件和正文；坏的整条当正文', () => {
  const event = formatSessionEvent({
    kind: 'notes',
    notes: [{ threadId: 'c1', title: '查依赖', status: 'completed', excerpt: '都不用升' }],
  })
  const item = projectItem(userText('u1', `${event}\n接着做下一步`)) as UserMessageItem
  assert.equal(item.kind, 'userMessage')
  assert.equal(item.text, '接着做下一步')
  assert.deepEqual(item.event, {
    kind: 'notes',
    notes: [{ threadId: 'c1', title: '查依赖', status: 'completed', excerpt: '都不用升' }],
  })

  // 回答里的换行在人读的那几行里压成一行，JSON 里留原文
  const multi = formatSessionEvent({
    kind: 'wake',
    notes: [{ threadId: 'c2', title: '跑测试', status: 'failed', excerpt: '两个没过：\n- a\n- b' }],
  })
  assert.ok(multi.includes('- "跑测试" (c2) failed: 两个没过： - a - b\n'))
  const back = projectItem(userText('u3', multi)) as UserMessageItem
  assert.equal(back.event?.notes[0]?.excerpt, '两个没过：\n- a\n- b')

  const broken = projectItem(userText('u2', '<litch-session-event>{坏的</litch-session-event>你好'))
  assert.equal((broken as UserMessageItem).event, undefined)
  assert.ok((broken as UserMessageItem).text.includes('你好'))
})

test('投影：子代理调用带上每个子线程的状态；litch_sessions.start 带上派出的会话或提案', () => {
  const collab = projectItem({
    type: 'collabAgentToolCall',
    id: 'c1',
    tool: 'spawnAgent',
    status: 'inProgress',
    senderThreadId: 'p',
    receiverThreadIds: ['a1', 'a2'],
    prompt: '分头看',
    model: null,
    reasoningEffort: null,
    agentsStates: { a1: { status: 'completed', message: '看完了' } },
  } as never) as ToolCallItem
  assert.deepEqual(collab.agents, [
    { threadId: 'a1', state: 'completed', message: '看完了' },
    { threadId: 'a2', state: null, message: null },
  ])

  const started = projectItem({
    type: 'dynamicToolCall',
    id: 'd1',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: { title: '查依赖', prompt: '看看', harness: 'pi' },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ thread_id: 'c9', note: 'ok' }) }],
    success: true,
    durationMs: 3,
  } as never) as ToolCallItem
  assert.deepEqual(started.spawned, {
    threadId: 'c9',
    proposalId: null,
    title: '查依赖',
    harness: 'pi',
  })

  const proposed = projectItem({
    type: 'dynamicToolCall',
    id: 'd2',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: { title: '整理', prompt: '整理一下', initiation: 'propose' },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ proposal_id: 'pr1', note: '' }) }],
    success: true,
    durationMs: 3,
  } as never) as ToolCallItem
  assert.equal(proposed.spawned?.proposalId, 'pr1')
  assert.equal(proposed.spawned?.threadId, null)

  // 别的工具不带
  const other = projectItem({
    type: 'dynamicToolCall',
    id: 'd3',
    namespace: 'litch_sessions',
    tool: 'list',
    arguments: {},
    status: 'completed',
    contentItems: [],
    success: true,
    durationMs: 1,
  } as never) as ToolCallItem
  assert.equal(other.spawned, undefined)
})

test('投影：父子关系的时间换成毫秒；不接受直接输入的子代理线程只能看', () => {
  const lineage = projectLineage(
    thread({
      id: 'c1',
      litchLineage: {
        parentThreadId: 'p',
        kind: 'fork',
        origin: 'model',
        title: '查依赖',
        wakeParent: true,
        createdAt: 1_700_000_100,
      },
    } as never),
  )
  assert.deepEqual(lineage, {
    parentId: 'p',
    kind: 'fork',
    origin: 'model',
    title: '查依赖',
    wakeParent: true,
    createdAt: 1_700_000_100_000,
    proposalId: null,
  })
  assert.equal(projectLineage(thread({ id: 'x' })), null)
  // 从提案开始的子会话带着提案号
  const started = projectLineage(
    thread({
      id: 'c2',
      litchLineage: {
        parentThreadId: 'p',
        kind: 'fresh',
        origin: 'proposal',
        title: '整理',
        wakeParent: true,
        createdAt: 1,
        proposalId: 'pr1',
      },
    } as never),
  )
  assert.equal(started?.proposalId, 'pr1')

  const mute = projectThread(
    thread({ id: 'a1', parentThreadId: 'p', canAcceptDirectInput: false }),
    { deviceId: 'local', harness: 'codex' },
  )
  assert.equal(mute.live, false)
  assert.deepEqual(mute.note, { key: 'session.agentReadOnly' })
  const open = projectThread(
    thread({ id: 'a2', parentThreadId: 'p', canAcceptDirectInput: true }),
    { deviceId: 'local', harness: 'codex' },
  )
  assert.equal(open.live, true)
})

test('投影：提案只留还在等、没过期的，按提出的先后排', () => {
  const base = {
    threadId: 'p',
    prompt: '做点事',
    cwd: null,
    startedThreadId: null,
    harness: null,
    model: null,
    kind: 'fresh',
    wakeParent: true,
    status: 'pending',
  }
  const list = [
    { ...base, id: 'b', title: 'B', createdAt: 20, expiresAt: NOW / 1000 + 60 },
    { ...base, id: 'a', title: 'A', createdAt: 10, expiresAt: NOW / 1000 + 60 },
    { ...base, id: 'old', title: '过期', createdAt: 5, expiresAt: NOW / 1000 - 1 },
    {
      ...base,
      id: 'done',
      title: '起了',
      createdAt: 5,
      expiresAt: NOW / 1000 + 60,
      status: 'started',
    },
  ] as unknown as SessionProposal[]
  assert.deepEqual(
    projectProposals(list, NOW).map((entry) => entry.id),
    ['a', 'b'],
  )
})

// —— 完整模式的设备 ——

const lineageOf = (parent: string, title: string) => ({
  parentThreadId: parent,
  kind: 'fresh',
  origin: 'model',
  title,
  wakeParent: true,
  createdAt: 1_700_000_050,
})

function treeWorld(options: { tree?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const record = (method: string, reply: unknown) => (params: unknown) => {
    calls.push({ method, params: params as Record<string, unknown> })
    return reply
  }
  const proposal = {
    id: 'pr1',
    threadId: 'p',
    title: '整理 CHANGELOG',
    prompt: '整理一下',
    harness: null,
    model: null,
    cwd: null,
    kind: 'fresh',
    wakeParent: true,
    status: 'pending',
    createdAt: NOW / 1000,
    expiresAt: NOW / 1000 + 3600,
    startedThreadId: null,
  }
  const codex = harness('codex', {
    declaration: { extensions: ['clientTools'], features: features() },
    threads: [
      thread({
        id: 'p',
        updatedAt: 1_700_000_300,
        turns: [turn('t1', [userText('u1', '分头做')])],
      }),
      // 派出来的 Litch 子会话：侧栏里挂在父会话下面
      thread({
        id: 'c1',
        updatedAt: 1_700_000_200,
        litchLineage: lineageOf('p', '查依赖'),
      } as never),
      // 引擎自己的子代理线程：不进侧栏
      thread({
        id: 'ag1',
        updatedAt: 1_700_000_100,
        parentThreadId: 'p',
        agentNickname: 'Hubble',
        agentRole: 'explorer',
        canAcceptDirectInput: false,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: 'p',
              depth: 1,
              agent_path: null,
              agent_nickname: 'Hubble',
              agent_role: 'explorer',
            },
          },
        },
      } as never),
    ],
  })
  const world = deviceWorld([codex, harness('dsh')], {
    prepare: (device) => {
      if (options.tree !== false) device.extensions.push('sessionTree')
    },
    extra: {
      'litch/session/start': (params) => {
        calls.push({ method: 'litch/session/start', params: params as Record<string, unknown> })
        codex.threads.push(thread({ id: 'c2', litchLineage: lineageOf('p', '新的') } as never))
        return { threadId: 'c2' }
      },
      'litch/session/detach': record('litch/session/detach', {}),
      'litch/sessionProposal/list': record('litch/sessionProposal/list', { proposals: [proposal] }),
      'litch/sessionProposal/accept': (params) => {
        calls.push({
          method: 'litch/sessionProposal/accept',
          params: params as Record<string, unknown>,
        })
        codex.threads.push(thread({ id: 'c3', litchLineage: lineageOf('p', '整理') } as never))
        return { threadId: 'c3' }
      },
      'litch/sessionProposal/dismiss': record('litch/sessionProposal/dismiss', {}),
    },
  })
  return { ...world, calls, codex }
}

const failureOf = async (promise: Promise<unknown>): Promise<ChannelError> => {
  try {
    await promise
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('应该失败')
}

test('设备：声明了会话树才算有；握手时客户端声明 sessionTree，自己的客户端工具里没有 litch_sessions', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  assert.equal(world.device()?.sessionTree, true)
  const init = world.peer.last().seen.find((entry) => entry.method === 'initialize')
  assert.ok(init)
  const caps = (init.params as { capabilities: Record<string, unknown> }).capabilities
  assert.ok((caps.litchExtensions as string[]).includes('sessionTree'))
  const namespaces = (caps.litchClientTools as { namespaces: string[] } | undefined)?.namespaces
  assert.ok(!namespaces?.includes('litch_sessions'))

  const bare = treeWorld({ tree: false })
  bare.core.start()
  await settle()
  assert.equal(bare.device()?.sessionTree, false)
  const failure = await failureOf(
    bare.command('session.spawn', {
      parentId: 'p',
      kind: 'fresh',
      title: '',
      prompt: '做',
      wakeParent: true,
    }),
  )
  assert.equal(failure.code, 'unsupported')
})

test('设备：建会话时声明了 clientTools 的 harness 带 litch_sessions；没声明会话树的设备不带', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  await world.command('session.create', { harness: 'codex', cwd: '/work', text: '你好' })
  const tools = world.sent('thread/start').at(-1)?.dynamicTools as { name: string }[] | undefined
  assert.deepEqual(
    tools?.map((entry) => entry.name),
    ['litch_sessions'],
  )

  const bare = treeWorld({ tree: false })
  bare.core.start()
  await settle()
  await bare.command('session.create', { harness: 'codex', cwd: '/work', text: '你好' })
  const plain = bare.sent('thread/start').at(-1)?.dynamicTools as { name: string }[] | undefined
  assert.ok(!(plain ?? []).some((entry) => entry.name === 'litch_sessions'))
})

test('设备：子代理线程不进侧栏；Litch 子会话带着父子关系；关系变了的通知改侧栏', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  assert.deepEqual([...world.side.sessions.keys()].sort(), ['c1', 'p'])
  assert.equal(world.side.sessions.get('c1')?.lineage?.parentId, 'p')
  assert.equal(world.side.sessions.get('p')?.lineage, null)

  // 子代理线程开始跑时对面会发 thread/started：也不进侧栏
  world.peer.last().notify('thread/started', {
    thread: thread({ id: 'ag2', parentThreadId: 'p' }),
  })
  await settle()
  assert.ok(!world.side.sessions.has('ag2'))

  world.peer.last().notify('litch/thread/lineage/updated', { threadId: 'c1', lineage: null })
  await settle()
  assert.equal(world.side.sessions.get('c1')?.lineage, null)
  world.peer
    .last()
    .notify('litch/thread/lineage/updated', { threadId: 'c1', lineage: lineageOf('p', '回来') })
  await settle()
  assert.equal(world.side.sessions.get('c1')?.lineage?.title, '回来')
})

test('设备：子代理线程列表按父会话问；能打开、能读，不能输入的标成只能看', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  const { agents } = (await world.command('session.agents', { sessionId: 'p' })) as {
    agents: { id: string; nickname: string | null; role: string | null; canInput: boolean | null }[]
  }
  assert.deepEqual(
    agents.map((entry) => [entry.id, entry.nickname, entry.role, entry.canInput]),
    [['ag1', 'Hubble', 'explorer', false]],
  )
  assert.equal(world.sent('thread/list').at(-1)?.parentThreadId, 'p')

  const watched = watchSession(world.core, 'ag1')
  await settle()
  assert.equal(watched.seen.view?.live, false)
  assert.deepEqual(watched.seen.view?.note, { key: 'session.agentReadOnly' })
  assert.ok(!world.side.sessions.has('ag1'))
  watched.close()
})

test('设备：对面不认 parentThreadId、回了全部会话时，只留父会话确实是它的子代理线程', async () => {
  const world = treeWorld()
  world.fake.byParent = false
  world.core.start()
  await settle()
  const { agents } = (await world.command('session.agents', { sessionId: 'p' })) as {
    agents: { id: string }[]
  }
  assert.deepEqual(
    agents.map((entry) => entry.id),
    ['ag1'],
  )
  assert.deepEqual([...world.side.sessions.keys()].sort(), ['c1', 'p'])
})

test('分块：派出子会话、启动子代理（开始时还不知道子线程）画成露在外面的卡片；等待子代理还是活动里的一行', () => {
  const spawn = projectItem({
    type: 'dynamicToolCall',
    id: 'd1',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: { title: 'x', prompt: 'y' },
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
  } as never)
  const collab = (tool: string) =>
    projectItem({
      type: 'collabAgentToolCall',
      id: tool,
      tool,
      status: 'inProgress',
      senderThreadId: 'p',
      receiverThreadIds: [],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    } as never)
  assert.equal(cardOf(spawn), true)
  assert.equal(cardOf(collab('spawnAgent')), true)
  assert.equal(cardOf(collab('wait')), false)
  assert.equal(cardOf(projectItem(userText('u', 'hi'))), false)
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'r', kind: 'reasoning' },
      { id: 'd1', kind: 'toolCall', card: true },
      { id: 'w', kind: 'toolCall' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'activity', key: 'r', itemIds: ['r'] },
      { type: 'card', itemId: 'd1' },
      { type: 'activity', key: 'w', itemIds: ['w'] },
    ],
  )
})

test('设备：派子会话发 litch/session/start，起好的立刻进侧栏；脱离发 detach 并先改侧栏', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  const { sessionId } = (await world.command('session.spawn', {
    parentId: 'p',
    harness: 'codex',
    kind: 'fork',
    title: '新的',
    prompt: '去做',
    wakeParent: false,
  })) as { sessionId: string }
  assert.equal(sessionId, 'c2')
  const start = world.calls.find((entry) => entry.method === 'litch/session/start')
  assert.deepEqual(start?.params, {
    parentThreadId: 'p',
    kind: 'fork',
    title: '新的',
    prompt: '去做',
    wakeParent: false,
    harness: 'codex',
  })
  await settle()
  assert.equal(world.side.sessions.get('c2')?.lineage?.parentId, 'p')

  await world.command('session.detach', { sessionId: 'c1' })
  assert.deepEqual(world.calls.find((entry) => entry.method === 'litch/session/detach')?.params, {
    threadId: 'c1',
  })
  await settle()
  assert.equal(world.side.sessions.get('c1')?.lineage, null)
})

test('设备：打开会话时取提案；变了的通知替换；开始、不要之后卡片收掉', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  const watched = watchSession(world.core, 'p')
  const proposals = (): SessionProposalView[] => watched.seen.view?.proposals ?? []
  await settle()
  await settle()
  assert.deepEqual(
    proposals().map((entry) => entry.id),
    ['pr1'],
  )
  assert.deepEqual(
    world.calls.find((entry) => entry.method === 'litch/sessionProposal/list')?.params,
    { threadId: 'p' },
  )

  world.peer.last().notify('litch/sessionProposal/changed', {
    threadId: 'p',
    proposals: [],
  })
  await settle()
  assert.deepEqual(proposals(), [])

  world.peer.last().notify('litch/sessionProposal/changed', {
    threadId: 'p',
    proposals: [
      {
        id: 'pr2',
        threadId: 'p',
        title: '清理分支',
        prompt: '列出来',
        harness: null,
        model: null,
        cwd: null,
        kind: 'fresh',
        wakeParent: true,
        status: 'pending',
        createdAt: NOW / 1000,
        expiresAt: NOW / 1000 + 3600,
        startedThreadId: null,
      },
    ],
  })
  await settle()
  assert.deepEqual(
    proposals().map((entry) => entry.title),
    ['清理分支'],
  )
  const { sessionId } = (await world.command('session.proposal.accept', {
    sessionId: 'p',
    proposalId: 'pr2',
  })) as { sessionId: string }
  assert.equal(sessionId, 'c3')
  await settle()
  assert.deepEqual(proposals(), [])
  assert.equal(world.side.sessions.get('c3')?.lineage?.parentId, 'p')
  watched.close()
})

// —— 模拟核心里的演示 ——

function mockWorld() {
  const time = fakeClock(NOW)
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: time.clock, chunkMs: 0 }), { clock: time.clock })
  const channel = connectChannel(uiPort)
  const sidebar = { view: null as SidebarView | null }
  channel.subscribe(
    { kind: 'sidebar', deviceId: 'local' },
    {
      snapshot: (data) => {
        sidebar.view = structuredClone(data)
      },
      delta(ops: SidebarOp[]) {
        const view = sidebar.view
        if (!view) return
        for (const op of ops) {
          if (op.op === 'session.upsert') {
            const at = view.sessions.findIndex((entry) => entry.id === op.session.id)
            if (at >= 0) view.sessions[at] = op.session
            else view.sessions.push(op.session)
          } else if (op.op === 'session.remove') {
            view.sessions = view.sessions.filter((entry) => entry.id !== op.sessionId)
          }
        }
      },
    },
  )
  const watch = (sessionId: string) => {
    const state = { view: null as SessionView | null }
    channel.subscribe(
      { kind: 'session', deviceId: 'local', sessionId },
      {
        snapshot: (data) => {
          state.view = structuredClone(data)
        },
        delta(ops: SessionOp[]) {
          for (const op of ops) if (state.view) reduceSession(state.view, structuredClone(op))
        },
      },
    )
    return state
  }
  const children = (parent: string): SessionSummary[] =>
    (sidebar.view?.sessions ?? []).filter((entry) => entry.lineage?.parentId === parent)
  /** 拨钟直到条件成立（模拟的回合都按定时器走） */
  const until = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 400 && !check(); i++) {
      time.advance(50)
      await settle()
    }
    assert.ok(check(), label)
  }
  return { channel, time, sidebar, watch, children, until }
}

const userItems = (view: SessionView | null): UserMessageItem[] =>
  Object.values(view?.items ?? {}).filter(
    (item): item is UserMessageItem => item.kind === 'userMessage',
  )

test('模拟：说“派子会话”派出两个子会话（侧栏里挂在父会话下），都做完后唤醒父会话', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '派子会话去查',
  })
  await settle()
  await world.until(() => world.children('s6').length === 2, '两个子会话进了侧栏')
  const kids = world.children('s6')
  assert.deepEqual(kids.map((entry) => entry.harness).sort(), ['claude', 'pi'])
  const cards = Object.values(parent.view?.items ?? {}).filter(
    (item): item is ToolCallItem => item.kind === 'toolCall' && item.spawned !== undefined,
  )
  assert.deepEqual(
    cards.map((item) => item.spawned?.threadId).sort(),
    kids.map((entry) => entry.id).sort(),
  )
  // 两个都停下之后，设备进程替父会话开一个唤醒的回合
  await world.until(
    () => userItems(parent.view).some((item) => item.event?.kind === 'wake'),
    '父会话被唤醒',
  )
  const wake = userItems(parent.view).find((item) => item.event?.kind === 'wake')
  assert.equal(wake?.event?.notes.length, 2)
  assert.equal(wake?.text, '')
})

test('模拟：说“提个子会话”出两张提案；短的那张到点收掉；开始的起出子会话，不要的收掉', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '提个子会话',
  })
  await world.until(() => (parent.view?.proposals.length ?? 0) === 2, '两张提案')
  const [first] = parent.view?.proposals ?? []
  assert.ok(first)
  await world.until(() => (parent.view?.proposals.length ?? 0) === 1, '短的那张过期')
  const { sessionId } = (await world.channel.command('session.proposal.accept', {
    deviceId: 'local',
    sessionId: 's6',
    proposalId: first.id,
  })) as { sessionId: string }
  await world.until(() => world.children('s6').some((entry) => entry.id === sessionId), '起出来了')
  assert.deepEqual(parent.view?.proposals, [])
  assert.equal(world.children('s6')[0]?.lineage?.origin, 'proposal')
  // 子会话记着是哪个提案：对话里那张提案卡片据此显示“已开始”
  assert.equal(world.children('s6')[0]?.lineage?.proposalId, first.id)

  const gone = await failureOf(
    world.channel.command('session.proposal.dismiss', {
      deviceId: 'local',
      sessionId: 's6',
      proposalId: first.id,
    }),
  )
  assert.equal(gone.code, 'notFound')
})

test('模拟：说“用子代理”出子代理卡片；能打开子线程，不能输入的那个只能看；脱离后不再挂着', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '用子代理看看',
  })
  await world.until(
    () =>
      Object.values(parent.view?.items ?? {}).some(
        (item) => item.kind === 'toolCall' && (item.agents?.length ?? 0) === 2,
      ),
    '子代理卡片',
  )
  const card = Object.values(parent.view?.items ?? {}).find(
    (item): item is ToolCallItem => item.kind === 'toolCall' && (item.agents?.length ?? 0) === 2,
  )
  const ids = card?.agents?.map((entry) => entry.threadId) ?? []
  assert.equal(ids.length, 2)
  // 子代理线程不进侧栏
  assert.ok(!(world.sidebar.view?.sessions ?? []).some((entry) => ids.includes(entry.id)))
  const views = ids.map((id) => world.watch(id))
  await world.until(() => views.every((view) => view.view !== null), '子线程打开了')
  assert.deepEqual(
    views.map((view) => view.view?.live),
    [true, false],
  )
  const muted = await failureOf(
    world.channel.command('session.send', {
      deviceId: 'local',
      sessionId: ids[1] ?? '',
      text: '在吗',
    }),
  )
  assert.equal(muted.code, 'rejected')
  const { agents } = (await world.channel.command('session.agents', {
    deviceId: 'local',
    sessionId: 's6',
  })) as { agents: { id: string; canInput: boolean | null }[] }
  assert.deepEqual(
    agents.map((entry) => entry.canInput),
    [true, false],
  )

  // 派一个、脱离它
  const { sessionId } = (await world.channel.command('session.spawn', {
    deviceId: 'local',
    parentId: 's6',
    kind: 'fresh',
    title: '手动派的',
    prompt: '去做',
    wakeParent: false,
  })) as { sessionId: string }
  await world.until(() => world.children('s6').some((entry) => entry.id === sessionId), '派出来了')
  await world.channel.command('session.detach', { deviceId: 'local', sessionId })
  await world.until(() => !world.children('s6').some((entry) => entry.id === sessionId), '脱离了')
})

test('模拟：没有会话树的设备不能派', async () => {
  const world = mockWorld()
  await settle()
  const failure = await failureOf(
    world.channel.command('session.spawn', {
      deviceId: 'nas',
      parentId: 'n1',
      kind: 'fresh',
      title: '',
      prompt: '做',
      wakeParent: false,
    }),
  )
  assert.equal(failure.code, 'unsupported')
})
