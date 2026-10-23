// 会话树：投影（注入的事件、子代理卡片、派出卡片、父子关系、只能看的子代理线程）、
// 完整模式的设备（声明、建会话带 litch_sessions、子代理线程不进侧栏、父子关系的通知、派出、提案、脱离），
// 以及模拟核心里的几出演示。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSessionEvent, type SessionProposal } from '../../protocol/src/index.mjs'
import {
  agentRunState,
  agentsUnfinished,
  bucketItems,
  type ChannelError,
  cardOf,
  cardPlace,
  connectChannel,
  createMockCore,
  createPortPair,
  proposalAsksUser,
  proposalOpen,
  proposalShape,
  proposalStatus,
  proposedBy,
  quietOf,
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
import {
  projectLineage,
  projectNativeLineage,
  projectSummary,
  projectThread,
} from '../src/projection/session.mjs'
import { mergeProposals, projectProposals } from '../src/projection/tree.mjs'
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
    arguments: { title: '查依赖', prompt: '看看', background: '要发版了', harness: 'pi' },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ thread_id: 'c9', note: 'ok' }) }],
    success: true,
    durationMs: 3,
  } as never) as ToolCallItem
  assert.deepEqual(started.spawned, {
    via: 'start',
    threadId: 'c9',
    proposalId: null,
    choice: null,
    title: '查依赖',
    prompt: '看看',
    background: '要发版了',
    harness: 'pi',
    model: null,
    effort: null,
    cwd: null,
    kind: 'fresh',
    asked: false,
  })
  // 直接派出去的子会话露在原处；提的提案进回合最下方的收尾区
  assert.equal(cardPlace(started), 'outside')

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
  assert.equal(proposed.spawned?.via, 'start')
  assert.equal(cardPlace(proposed), 'tail')
  // 用户亲口要的（user_asked）：开始时是派出的卡；设备进程核对不过、降成了提案的，有了结果就进收尾区
  const askedArgs = { title: '整理', prompt: '整理一下', initiation: 'user_asked', effort: 'high' }
  const asked = projectItem({
    type: 'dynamicToolCall',
    id: 'd6',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: askedArgs,
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
  } as never) as ToolCallItem
  assert.equal(asked.spawned?.asked, true)
  assert.equal(asked.spawned?.effort, 'high')
  assert.equal(cardPlace(asked), 'outside')
  const demoted = projectItem({
    type: 'dynamicToolCall',
    id: 'd6',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: askedArgs,
    status: 'completed',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ proposal_id: 'pr2', note: '' }) }],
    success: true,
    durationMs: 3,
  } as never) as ToolCallItem
  assert.equal(cardPlace(demoted), 'tail')

  // offer 卡：调用还在等用户选，没有结果；选了之后结果里有提案号和选择
  const offerArgs = { title: '加导出按钮', initiation: 'offer' }
  const waitingOffer = projectItem({
    type: 'dynamicToolCall',
    id: 'd4',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: offerArgs,
    status: 'inProgress',
    contentItems: null,
    success: null,
    durationMs: null,
  } as never) as ToolCallItem
  assert.deepEqual(
    [waitingOffer.spawned?.via, waitingOffer.spawned?.proposalId, waitingOffer.spawned?.choice],
    ['offer', null, null],
  )
  assert.equal(waitingOffer.spawned?.prompt, '')
  assert.equal(cardPlace(waitingOffer), 'outside')
  const answered = projectItem({
    type: 'dynamicToolCall',
    id: 'd4',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: offerArgs,
    status: 'completed',
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify({ proposal_id: 'pr7', choice: 'session', note: 'accept it' }),
      },
    ],
    success: true,
    durationMs: 9000,
  } as never) as ToolCallItem
  assert.deepEqual(
    [answered.spawned?.via, answered.spawned?.proposalId, answered.spawned?.choice],
    ['offer', 'pr7', 'session'],
  )

  // hand_off：交给分叉会话，结果里的 thread_id 是子会话，剩下的计划当简报
  const handed = projectItem({
    type: 'dynamicToolCall',
    id: 'd5',
    namespace: 'litch_sessions',
    tool: 'hand_off',
    arguments: { title: '整理排序', remaining_plan: '1. 换成稳定排序\n2. 补单测' },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: JSON.stringify({ thread_id: 'c8', note: 'ok' }) }],
    success: true,
    durationMs: 3,
  } as never) as ToolCallItem
  assert.deepEqual(handed.spawned, {
    via: 'handOff',
    threadId: 'c8',
    proposalId: null,
    choice: null,
    title: '整理排序',
    prompt: '1. 换成稳定排序\n2. 补单测',
    background: '',
    harness: null,
    model: null,
    effort: null,
    cwd: null,
    kind: 'fork',
    asked: false,
  })
  assert.equal(cardPlace(handed), 'outside')

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

test('投影：别的应用派出来的会话带着是谁派的、父会话；没有的、形状不对的是 null', () => {
  assert.deepEqual(
    projectNativeLineage(
      thread({ id: 'n', createdAt: 100, litchNativeLineage: { app: 'claude-desktop' } } as never),
    ),
    { app: 'claude-desktop', parentId: null, createdAt: 100_000 },
  )
  assert.equal(
    projectNativeLineage(
      thread({
        id: 'n',
        litchNativeLineage: { app: 'claude-desktop', parentThreadId: 'p' },
      } as never),
    )?.parentId,
    'p',
  )
  // 自己挂在自己下面、父会话不是字符串的：当认不出父会话
  for (const parentThreadId of ['n', 7, ''])
    assert.equal(
      projectNativeLineage(
        thread({ id: 'n', litchNativeLineage: { app: 'claude-desktop', parentThreadId } } as never),
      )?.parentId,
      null,
    )
  assert.equal(projectNativeLineage(thread({ id: 'x' })), null)
  assert.equal(
    projectNativeLineage(thread({ id: 'y', litchNativeLineage: { app: 3 } } as never)),
    null,
  )
  const summary = projectSummary(
    thread({ id: 'n', litchNativeLineage: { app: 'claude-desktop' } } as never),
    { harness: 'claude', workspaceId: null },
  )
  assert.equal(summary.nativeLineage?.app, 'claude-desktop')
})

test('投影：提案连了结的一起留，按提出的先后排；还等着却过了期的算过期', () => {
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
    {
      ...base,
      id: 'a',
      title: 'A',
      createdAt: 10,
      expiresAt: NOW / 1000 + 60,
      turnId: 't1',
      callId: 'call1',
      cwd: '/w/a',
      background: '这一轮在提速',
    },
    { ...base, id: 'old', title: '过期', createdAt: 5, expiresAt: NOW / 1000 - 1 },
    {
      ...base,
      id: 'done',
      title: '起了',
      createdAt: 6,
      expiresAt: NOW / 1000 + 60,
      status: 'started',
      startedThreadId: 'c9',
      settledAt: 7,
    },
    { ...base, id: 'bad', title: '不认识', createdAt: 8, status: 'gone' },
  ] as unknown as SessionProposal[]
  const views = projectProposals(list, NOW)
  assert.deepEqual(
    views.map((entry) => [entry.id, entry.status]),
    [
      ['old', 'expired'],
      ['done', 'started'],
      ['a', 'pending'],
      ['b', 'pending'],
    ],
  )
  assert.equal(views[0]?.settledAt, NOW - 1000)
  assert.equal(views[1]?.startedId, 'c9')
  assert.equal(views[1]?.settledAt, 7000)
  assert.deepEqual([views[2]?.turnId, views[2]?.callId, views[2]?.cwd], ['t1', 'call1', '/w/a'])
  // 背景：给了的照给的，旧设备进程没带的是空串
  assert.deepEqual([views[2]?.background, views[3]?.background], ['这一轮在提速', ''])
  // 等着的过了期，界面现算成过期
  const pending = views[3]
  assert.ok(pending)
  assert.equal(proposalStatus(pending, NOW), 'pending')
  assert.equal(proposalStatus(pending, NOW + 61_000), 'expired')
})

test('投影：提案变了的通知并进手上的：变了的、等着的盖掉旧的，不知去向的等着的拿掉，了结的留着', () => {
  const raw = (id: string, status: string, createdAt: number) =>
    ({
      id,
      threadId: 'p',
      title: id,
      prompt: '',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      status,
      createdAt,
      expiresAt: NOW / 1000 + 60,
      startedThreadId: status === 'started' ? `c-${id}` : null,
    }) as unknown as SessionProposal
  const current = projectProposals(
    [raw('old', 'dismissed', 1), raw('a', 'pending', 2), raw('b', 'pending', 3)],
    NOW,
  )
  const merged = mergeProposals(current, [raw('c', 'pending', 4)], [raw('a', 'started', 2)], NOW)
  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.status]),
    [
      ['old', 'dismissed'],
      ['a', 'started'],
      ['c', 'pending'],
    ],
  )
  assert.equal(merged[1]?.startedId, 'c-a')
})

test('投影：offer 卡的三种状态和标记；等选的、等补简报的不过期，通知里没列也留着', () => {
  const raw = (id: string, status: string, createdAt: number, offer = true) =>
    ({
      id,
      threadId: 'p',
      title: id,
      prompt: '',
      harness: null,
      model: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      status,
      offer,
      createdAt,
      expiresAt: NOW / 1000 - 1,
      startedThreadId: null,
      callId: `call-${id}`,
    }) as unknown as SessionProposal
  const views = projectProposals(
    [
      raw('o1', 'offered', 1),
      raw('o2', 'chosen', 2),
      raw('o3', 'here', 3),
      raw('p1', 'pending', 4, false),
    ],
    NOW,
  )
  assert.deepEqual(
    views.map((entry) => [entry.id, entry.status, entry.offer]),
    [
      ['o1', 'offered', true],
      ['o2', 'chosen', true],
      ['o3', 'here', true],
      ['p1', 'expired', false],
    ],
  )
  assert.deepEqual(
    views.map((entry) => [proposalAsksUser(entry.status), proposalOpen(entry.status)]),
    [
      [true, true],
      [false, true],
      [false, false],
      [false, false],
    ],
  )
  // 通知里“全部等着的”只列 pending 的：offer 卡没变就不在里面，照样留着
  const merged = mergeProposals(views, [], [raw('o3', 'here', 3)], NOW)
  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.status]),
    [
      ['o1', 'offered'],
      ['o2', 'chosen'],
      ['o3', 'here'],
      ['p1', 'expired'],
    ],
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
      'litch/sessionProposal/answer': record('litch/sessionProposal/answer', {}),
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

/** 一次 litch_sessions.wrap_up 调用的条目 */
const wrapUpItem = (id: string, suggestions: unknown[], result?: unknown) =>
  projectItem({
    type: 'dynamicToolCall',
    id,
    namespace: 'litch_sessions',
    tool: 'wrap_up',
    arguments: { suggestions },
    status: result ? 'completed' : 'inProgress',
    contentItems: result ? [{ type: 'inputText', text: JSON.stringify(result) }] : null,
    success: result ? true : null,
    durationMs: result ? 2 : null,
  } as never) as ToolCallItem

test('投影：收尾调用的每条建议按顺序对上结果里的提案或拒绝原因；空的不画，带建议的是卡片', () => {
  const asked = [
    {
      title: '补测试',
      prompt: '给解析器补测试',
      background: '解析刚改过',
      harness: 'pi',
      cwd: '~/x',
    },
    { title: '对文案', prompt: '逐键对一遍', background: 'fork 不用', kind: 'fork' },
    { title: '看看', prompt: '看看' },
  ]
  // 还没有结果：都是 null；参数一开始就有，所以开始时就定了画成卡片
  const running = wrapUpItem('w1', asked)
  assert.deepEqual(
    running.wrapUp?.suggestions.map((entry) => [entry.proposalId, entry.refused]),
    [
      [null, null],
      [null, null],
      [null, null],
    ],
  )
  assert.equal(cardOf(running), true)
  assert.equal(cardPlace(running), 'tail')
  assert.equal(quietOf(running), false)

  const done = wrapUpItem('w1', asked, {
    suggestions: [
      { title: '补测试', proposal_id: 'pr1' },
      { title: '对文案', proposal_id: 'pr2' },
      { title: '看看', refused: 'too short' },
    ],
    note: '',
  })
  assert.deepEqual(done.wrapUp?.suggestions, [
    {
      title: '补测试',
      prompt: '给解析器补测试',
      background: '解析刚改过',
      harness: 'pi',
      model: null,
      effort: null,
      cwd: '~/x',
      kind: 'fresh',
      proposalId: 'pr1',
      refused: null,
    },
    {
      title: '对文案',
      prompt: '逐键对一遍',
      background: '',
      harness: null,
      model: null,
      effort: null,
      cwd: null,
      kind: 'fork',
      proposalId: 'pr2',
      refused: null,
    },
    {
      title: '看看',
      prompt: '看看',
      background: '',
      harness: null,
      model: null,
      effort: null,
      cwd: null,
      kind: 'fresh',
      proposalId: null,
      refused: 'too short',
    },
  ])
  assert.equal(done.spawned, undefined)

  // 结果的顺序和参数对不上：按标题找
  const shuffled = wrapUpItem('w2', asked.slice(0, 2), {
    suggestions: [
      { title: '对文案', proposal_id: 'pr2' },
      { title: '补测试', proposal_id: 'pr1' },
    ],
    note: '',
  })
  assert.deepEqual(
    shuffled.wrapUp?.suggestions.map((entry) => entry.proposalId),
    ['pr1', 'pr2'],
  )

  // 整个调用失败（设备进程不认 wrap_up、参数不对）：一张都没收，每条都写成没收下、原因是那句话
  const failed = projectItem({
    type: 'dynamicToolCall',
    id: 'w4',
    namespace: 'litch_sessions',
    tool: 'wrap_up',
    arguments: { suggestions: asked.slice(0, 2) },
    status: 'failed',
    contentItems: [
      { type: 'inputText', text: '[litch:invalid] litch_sessions has no tool "wrap_up".' },
    ],
    success: false,
    durationMs: 1,
  } as never) as ToolCallItem
  assert.deepEqual(
    failed.wrapUp?.suggestions.map((entry) => [entry.proposalId, entry.refused]),
    [
      [null, '[litch:invalid] litch_sessions has no tool "wrap_up".'],
      [null, '[litch:invalid] litch_sessions has no tool "wrap_up".'],
    ],
  )

  // 没有建议的收尾：不画，也不是卡片
  const empty = wrapUpItem('w3', [], { suggestions: [], note: '' })
  assert.deepEqual(empty.wrapUp, { suggestions: [] })
  assert.equal(quietOf(empty), true)
  assert.equal(cardOf(empty), false)
  // 别的工具调用都不是“不画”的
  assert.equal(quietOf(projectItem(userText('u', 'hi'))), false)

  // 只留了问题、没有建议的收尾：照样画（问题和按钮在回合最下方）；按钮至多两个，没字的不要，没问题时按钮不要
  const asking = projectItem({
    type: 'dynamicToolCall',
    id: 'w5',
    namespace: 'litch_sessions',
    tool: 'wrap_up',
    arguments: {
      suggestions: [],
      ask: ' 在这里接着修吗？ ',
      actions: [
        { label: '修吧', message: '好，在这里修' },
        { label: '  ' },
        { label: '先不', message: '' },
        { label: '第三个' },
      ],
    },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: '{"suggestions":[]}' }],
    success: true,
    durationMs: 1,
  } as never) as ToolCallItem
  assert.deepEqual(asking.wrapUp, {
    suggestions: [],
    ask: '在这里接着修吗？',
    actions: [{ label: '修吧', message: '好，在这里修' }, { label: '先不' }],
  })
  assert.equal(quietOf(asking), false)
  assert.equal(cardPlace(asking), 'tail')
  const buttonsOnly = wrapUpItem('w6', [], { suggestions: [] })
  assert.equal(quietOf(buttonsOnly), true)
})

test('投影：设备进程的提醒（kind="remind"）拆成事件，没有用户自己的话', () => {
  const text = formatSessionEvent({ kind: 'remind', notes: [] })
  const item = projectItem(userText('u1', text)) as UserMessageItem
  assert.equal(item.text, '')
  assert.deepEqual(item.event, { kind: 'remind', notes: [] })
})

test('分块：不画的条目不占块、不算进步骤；回合只剩提示时照旧直接露出来', () => {
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'r', kind: 'reasoning' },
      { id: 'a', kind: 'agentMessage', phase: 'final' },
      { id: 'w', kind: 'toolCall', quiet: true },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'process', key: 'r', parts: [{ type: 'steps', key: 'r', itemIds: ['r'] }] },
      { type: 'answer', itemId: 'a' },
    ],
  )
  assert.deepEqual(
    bucketItems([
      { id: 'n', kind: 'notice' },
      { id: 'w', kind: 'toolCall', quiet: true },
    ]),
    [{ type: 'notes', key: 'n', itemIds: ['n'] }],
  )
  // 提醒收尾的回合：模型顺口说的话收进过程（当说明段，不算最终回答），带建议的收尾照样有卡片（在收尾区）
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage', remind: true },
      { id: 'w', kind: 'toolCall', card: 'tail', wrapUp: true },
      { id: 'a', kind: 'agentMessage', phase: 'final' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      {
        type: 'process',
        key: 'w',
        parts: [
          { type: 'steps', key: 'w', itemIds: ['w'] },
          { type: 'note', itemId: 'a' },
        ],
      },
      { type: 'tail', itemIds: ['w'] },
    ],
  )
})

test('分块：一回合的建议卡片和收尾的问题都排在最终回答下面，过程里原位置只留一行；offer 卡不挪', () => {
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'c', kind: 'command' },
      { id: 's', kind: 'toolCall', card: 'tail' },
      { id: 'm', kind: 'agentMessage', phase: 'commentary' },
      { id: 'o', kind: 'toolCall', card: 'outside' },
      { id: 'w', kind: 'toolCall', card: 'tail', wrapUp: true },
      { id: 'a', kind: 'agentMessage', phase: 'final' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      {
        type: 'process',
        key: 'c',
        parts: [
          { type: 'steps', key: 'c', itemIds: ['c', 's'] },
          { type: 'note', itemId: 'm' },
        ],
      },
      { type: 'card', itemId: 'o' },
      { type: 'process', key: 'w', parts: [{ type: 'steps', key: 'w', itemIds: ['w'] }] },
      { type: 'answer', itemId: 'a' },
      { type: 'tail', itemIds: ['s', 'w'] },
    ],
  )
  // 旧顺序（先写完整回答、再调带建议的收尾、再补一句）：和空收尾一样，前后的话都算回答
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'a1', kind: 'agentMessage', phase: 'commentary' },
      { id: 'w', kind: 'toolCall', card: 'tail', wrapUp: true },
      { id: 'a2', kind: 'agentMessage', phase: 'final' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'answer', itemId: 'a1' },
      { type: 'process', key: 'w', parts: [{ type: 'steps', key: 'w', itemIds: ['w'] }] },
      { type: 'answer', itemId: 'a2' },
      { type: 'tail', itemIds: ['w'] },
    ],
  )
})

test('分块：回合还在跑时收尾带的卡片和问题先不进收尾区，过程里那一步照留；中途 start 的提案照旧进', () => {
  const items = [
    { id: 'u', kind: 'userMessage' as const },
    { id: 's', kind: 'toolCall' as const, card: 'tail' as const },
    { id: 'w', kind: 'toolCall' as const, card: 'tail' as const, wrapUp: true },
    { id: 'a', kind: 'agentMessage' as const, phase: 'unknown' as const },
  ]
  // 先收尾、回答正在写：回答照旧认得出来，收尾区里只有中途提的那张
  assert.deepEqual(bucketItems(items, { turnRunning: true }), [
    { type: 'user', itemId: 'u' },
    { type: 'process', key: 's', parts: [{ type: 'steps', key: 's', itemIds: ['s', 'w'] }] },
    { type: 'answer', itemId: 'a' },
    { type: 'tail', itemIds: ['s'] },
  ])
  // 回合结束（不传、传 false 都一样）：收尾带的排进来，按调用先后
  const ended = bucketItems(items, { turnRunning: false })
  assert.deepEqual(ended.at(-1), { type: 'tail', itemIds: ['s', 'w'] })
  assert.deepEqual(bucketItems(items), ended)
  // 只有收尾的回合在跑：没有收尾区
  assert.equal(
    bucketItems([items[0], items[2], items[3]] as typeof items, { turnRunning: true }).some(
      (block) => block.type === 'tail',
    ),
    false,
  )
})

test('提案卡片写什么：开始了、子会话在侧栏里的写实际的 harness、目录、方式；别的写提案的，没给的跟父会话', () => {
  const planned = { harness: 'pi', model: 'm1', effort: 'high', cwd: '~/a', kind: 'fork' as const }
  assert.deepEqual(proposalShape(planned, undefined, 'claude'), {
    harness: 'pi',
    model: 'm1',
    effort: 'high',
    cwd: '~/a',
    kind: 'fork',
    actual: false,
  })
  assert.equal(proposalShape({ ...planned, harness: null }, null, 'claude').harness, 'claude')
  const child = {
    harness: 'dsh',
    cwd: '/work/b',
    lineage: {
      parentId: 'p',
      kind: 'fresh' as const,
      origin: 'proposal' as const,
      title: 'x',
      wakeParent: true,
      createdAt: 0,
      proposalId: 'pr1',
    },
  }
  assert.deepEqual(proposalShape(planned, child, 'claude'), {
    harness: 'dsh',
    model: null,
    effort: null,
    cwd: '/work/b',
    kind: 'fresh',
    actual: true,
  })
})

test('分块：派出子会话、启动子代理（开始时还不知道子线程）画成卡片；等待子代理还是步骤组里的一行', () => {
  const spawn = projectItem({
    type: 'dynamicToolCall',
    id: 'd1',
    namespace: 'litch_sessions',
    tool: 'start',
    arguments: { title: 'x', prompt: 'y', initiation: 'user_asked' },
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
  assert.equal(cardPlace(spawn), 'outside')
  assert.equal(cardPlace(collab('spawnAgent')), 'inline')
  assert.equal(cardPlace(collab('wait')), null)
  assert.deepEqual(
    bucketItems([
      { id: 'u', kind: 'userMessage' },
      { id: 'r', kind: 'reasoning' },
      { id: 'd1', kind: 'toolCall', card: 'outside' },
      { id: 'w', kind: 'toolCall' },
    ]),
    [
      { type: 'user', itemId: 'u' },
      { type: 'process', key: 'r', parts: [{ type: 'steps', key: 'r', itemIds: ['r'] }] },
      { type: 'card', itemId: 'd1' },
      { type: 'process', key: 'w', parts: [{ type: 'steps', key: 'w', itemIds: ['w'] }] },
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

test('设备：打开会话时连了结的一起取提案；变了的通知并进去；开始、不要之后记成了结', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  const watched = watchSession(world.core, 'p')
  const proposals = (): SessionProposalView[] => watched.seen.view?.proposals ?? []
  const states = () => proposals().map((entry) => [entry.id, entry.status])
  await settle()
  await settle()
  assert.deepEqual(states(), [['pr1', 'pending']])
  assert.deepEqual(
    world.calls.find((entry) => entry.method === 'litch/sessionProposal/list')?.params,
    { threadId: 'p', includeSettled: true },
  )

  const raw = {
    threadId: 'p',
    prompt: '列出来',
    harness: null,
    model: null,
    cwd: null,
    kind: 'fresh',
    wakeParent: true,
    createdAt: NOW / 1000 + 1,
    expiresAt: NOW / 1000 + 3600,
    startedThreadId: null,
  }
  // 模型撤回了 pr1、又提了 pr2：变了的那条带着状态，等着的只剩 pr2
  world.peer.last().notify('litch/sessionProposal/changed', {
    threadId: 'p',
    proposals: [{ ...raw, id: 'pr2', title: '清理分支', status: 'pending' }],
    changed: [
      { ...raw, id: 'pr1', title: '整理 CHANGELOG', status: 'withdrawn', createdAt: NOW / 1000 },
      { ...raw, id: 'pr2', title: '清理分支', status: 'pending' },
    ],
  })
  await settle()
  assert.deepEqual(states(), [
    ['pr1', 'withdrawn'],
    ['pr2', 'pending'],
  ])

  const { sessionId } = (await world.command('session.proposal.accept', {
    sessionId: 'p',
    proposalId: 'pr2',
    overrides: { harness: 'dsh', title: '清理旧分支', sandbox: 'read-only', wakeParent: false },
  })) as { sessionId: string }
  assert.equal(sessionId, 'c3')
  assert.deepEqual(
    world.calls.find((entry) => entry.method === 'litch/sessionProposal/accept')?.params,
    {
      proposalId: 'pr2',
      overrides: {
        harness: 'dsh',
        title: '清理旧分支',
        wakeParent: false,
        sandbox: 'read-only',
        approvalPolicy: 'on-request',
      },
    },
  )
  await settle()
  // 不等通知，卡片先写“已开始”、记着起出来的子会话
  assert.deepEqual(states(), [
    ['pr1', 'withdrawn'],
    ['pr2', 'started'],
  ])
  assert.equal(proposals()[1]?.startedId, 'c3')
  assert.equal(world.side.sessions.get('c3')?.lineage?.parentId, 'p')
  watched.close()
})

test('设备：没改的“开始”不带 overrides；“不要”记成不要了', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  const watched = watchSession(world.core, 'p')
  await settle()
  await settle()
  await world.command('session.proposal.accept', { sessionId: 'p', proposalId: 'pr1' })
  assert.deepEqual(
    world.calls.find((entry) => entry.method === 'litch/sessionProposal/accept')?.params,
    { proposalId: 'pr1' },
  )
  await world.command('session.proposal.dismiss', { sessionId: 'p', proposalId: 'pr1' })
  await settle()
  assert.equal(watched.seen.view?.proposals[0]?.status, 'dismissed')
  watched.close()
})

test('设备：offer 卡上选“新会话”先记成等补简报（不起子会话），选“在这里做”记成在这里做', async () => {
  const world = treeWorld()
  world.core.start()
  await settle()
  const watched = watchSession(world.core, 'p')
  await settle()
  await settle()
  await world.command('session.proposal.answer', {
    sessionId: 'p',
    proposalId: 'pr1',
    choice: 'session',
  })
  assert.deepEqual(
    world.calls.find((entry) => entry.method === 'litch/sessionProposal/answer')?.params,
    { proposalId: 'pr1', choice: 'session' },
  )
  await settle()
  const first = watched.seen.view?.proposals[0]
  assert.deepEqual([first?.status, first?.settledAt, first?.startedId], ['chosen', null, null])
  assert.equal(
    world.calls.some((entry) => entry.method === 'litch/sessionProposal/accept'),
    false,
  )
  await world.command('session.proposal.answer', {
    sessionId: 'p',
    proposalId: 'pr1',
    choice: 'here',
  })
  await settle()
  const second = watched.seen.view?.proposals[0]
  assert.equal(second?.status, 'here')
  assert.ok(second?.settledAt)
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

test('模拟：说“提个子会话”出三张提案；短的那张到点过期；开始（可改）的起出子会话，了结的留着', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '提个子会话',
  })
  const list = () => parent.view?.proposals ?? []
  await world.until(() => list().length === 3, '三张提案')
  const [first, short, third] = list()
  assert.ok(first && short && third)
  // 对话里那几条 litch_sessions.start 就是提案的锚点
  const calls = Object.values(parent.view?.items ?? {}).filter(
    (item): item is ToolCallItem => item.kind === 'toolCall' && item.spawned !== undefined,
  )
  assert.deepEqual(
    calls.map((item) => item.id).sort(),
    list()
      .map((entry) => entry.callId)
      .sort(),
  )
  assert.equal(third.harness, 'pi')
  assert.equal(third.widerSandbox, 'danger-full-access')
  await world.until(() => list()[1]?.status === 'expired', '短的那张过期')

  const { sessionId } = (await world.channel.command('session.proposal.accept', {
    deviceId: 'local',
    sessionId: 's6',
    proposalId: first.id,
    overrides: { title: '整理更新记录', harness: 'pi' },
  })) as { sessionId: string }
  await world.until(() => world.children('s6').some((entry) => entry.id === sessionId), '起出来了')
  const child = world.children('s6').find((entry) => entry.id === sessionId)
  assert.equal(child?.lineage?.origin, 'proposal')
  assert.equal(child?.title, '整理更新记录')
  assert.equal(child?.harness, 'pi')
  // 子会话记着是哪个提案：对话里那张提案卡片据此显示“已开始”
  assert.equal(child?.lineage?.proposalId, first.id)
  assert.equal(list()[0]?.status, 'started')
  assert.equal(list()[0]?.startedId, sessionId)

  const gone = await failureOf(
    world.channel.command('session.proposal.dismiss', {
      deviceId: 'local',
      sessionId: 's6',
      proposalId: first.id,
    }),
  )
  assert.equal(gone.code, 'notFound')
  await world.channel.command('session.proposal.dismiss', {
    deviceId: 'local',
    sessionId: 's6',
    proposalId: third.id,
  })
  await world.until(() => list()[2]?.status === 'dismissed', '不要的那张记成不要了')
  assert.deepEqual(
    list().map((entry) => entry.status),
    ['started', 'expired', 'dismissed'],
  )
})

test('模拟：说“撤回提案”模型撤回最近一个还等着的提案；没有可撤回的照实说', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  const say = async (text: string) => {
    const before = parent.view?.turns.length ?? 0
    await world.channel.command('session.send', { deviceId: 'local', sessionId: 's6', text })
    await world.until(
      () =>
        (parent.view?.turns.length ?? 0) > before &&
        parent.view?.turns.at(-1)?.status === 'completed',
      `“${text}”这一回合结束`,
    )
  }
  await say('提个子会话')
  await say('撤回提案')
  const list = () => parent.view?.proposals ?? []
  assert.deepEqual(
    list().map((entry) => entry.status),
    ['pending', 'pending', 'withdrawn'],
  )
  const withdrawCall = Object.values(parent.view?.items ?? {}).find(
    (item) => item.kind === 'toolCall' && item.tool === 'withdraw',
  )
  assert.ok(withdrawCall, '对话里有撤回的那次调用')
})

test('模拟：说“新任务”出 offer 卡、调用等着；选新会话模型补简报起出子会话，选在这里做模型在这里回答', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  const offerCall = () =>
    Object.values(parent.view?.items ?? {}).findLast(
      (item): item is ToolCallItem => item.kind === 'toolCall' && item.spawned?.via === 'offer',
    )
  const list = () => parent.view?.proposals ?? []
  const ask = async () => {
    const before = list().length
    await world.channel.command('session.send', {
      deviceId: 'local',
      sessionId: 's6',
      text: '新任务：给设置页加个导出按钮',
    })
    await world.until(() => list().length === before + 1, '出了一张 offer 卡')
    const offer = list().at(-1)
    assert.ok(offer)
    assert.deepEqual([offer.status, offer.offer, offer.prompt], ['offered', true, ''])
    // 调用还在等：没有结果，卡片按 callId 对上提案
    const call = offerCall()
    assert.equal(call?.status, 'inProgress')
    assert.equal(call?.spawned?.proposalId, null)
    assert.equal(offer.callId, call?.id)
    assert.equal(parent.view?.turns.at(-1)?.status, 'running')
    return offer
  }
  const first = await ask()
  await world.channel.command('session.proposal.answer', {
    deviceId: 'local',
    sessionId: 's6',
    proposalId: first.id,
    choice: 'session',
  })
  await world.until(() => list().at(-1)?.status === 'chosen', '选了新会话，等模型补简报')
  assert.deepEqual(
    [offerCall()?.spawned?.proposalId, offerCall()?.spawned?.choice],
    [first.id, 'session'],
  )
  await world.until(() => list().at(-1)?.status === 'started', '补上简报、起了子会话')
  const started = list().at(-1)
  assert.ok(started?.prompt, '简报补上了')
  const child = world.children('s6').find((entry) => entry.id === started?.startedId)
  assert.equal(child?.lineage?.proposalId, first.id)
  await world.until(
    () => parent.view?.turns.at(-1)?.status === 'completed',
    '父会话回一句、回合结束',
  )
  // 选过了不能再选
  await assert.rejects(
    world.channel.command('session.proposal.answer', {
      deviceId: 'local',
      sessionId: 's6',
      proposalId: first.id,
      choice: 'here',
    }),
  )

  const second = await ask()
  await world.channel.command('session.proposal.answer', {
    deviceId: 'local',
    sessionId: 's6',
    proposalId: second.id,
    choice: 'here',
  })
  await world.until(() => parent.view?.turns.at(-1)?.status === 'completed', '在这里回答完')
  assert.equal(list().at(-1)?.status, 'here')
  assert.equal(offerCall()?.spawned?.choice, 'here')

  // 没选就停了回合：算在这里做
  const third = await ask()
  await world.channel.command('session.interrupt', { deviceId: 'local', sessionId: 's6' })
  await world.until(() => list().at(-1)?.status === 'here', '停了回合算在这里做')
  assert.equal(list().at(-1)?.id, third.id)
})

test('模拟：说“交接”模型把手上的任务交给分叉会话（不出卡，立刻起），再回答新消息', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  const before = world.children('s6').length
  const turns = parent.view?.turns.length ?? 0
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '先交接一下，回答我另一个问题',
  })
  await world.until(
    () =>
      (parent.view?.turns.length ?? 0) > turns && parent.view?.turns.at(-1)?.status === 'completed',
    '回合结束',
  )
  const handed = Object.values(parent.view?.items ?? {}).find(
    (item): item is ToolCallItem => item.kind === 'toolCall' && item.spawned?.via === 'handOff',
  )
  assert.ok(handed?.spawned?.threadId, '对话里有交接那一条，带着分叉会话')
  const kids = world.children('s6')
  assert.equal(kids.length, before + 1)
  const fork = kids.find((entry) => entry.id === handed.spawned?.threadId)
  assert.equal(fork?.lineage?.kind, 'fork')
  assert.equal(parent.view?.proposals.length, 0, '交接不出卡')
})

test('模拟：说“收尾建议”先调收尾（三条建议加一个问题）再回答：两条成了提案（callId 是那次调用），一条被拒；别的几出调空的收尾', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  const say = async (text: string) => {
    const before = parent.view?.turns.length ?? 0
    await world.channel.command('session.send', { deviceId: 'local', sessionId: 's6', text })
    await world.until(
      () =>
        (parent.view?.turns.length ?? 0) > before &&
        parent.view?.turns.at(-1)?.status === 'completed',
      `“${text}”这一回合结束`,
    )
  }
  const lastTurnItems = () =>
    (parent.view?.turns.at(-1)?.itemIds ?? []).map((id) => parent.view?.items[id])
  await say('收尾建议')
  const items = lastTurnItems()
  // 照桌面端的做法：先调收尾，最后的话写在它后面（卡片和问题由收尾区排到回答下面）
  assert.equal(items.at(-1)?.kind, 'agentMessage')
  const call = items.at(-2) as ToolCallItem
  assert.equal(call.tool, 'wrap_up')
  assert.equal(cardOf(call), true)
  assert.ok(call.wrapUp?.ask, '带着问题')
  assert.equal(call.wrapUp?.actions?.length, 2)
  const suggestions = call.wrapUp?.suggestions ?? []
  assert.equal(suggestions.length, 3)
  assert.ok(suggestions[2]?.refused, '第三条被拒，带着原因')
  const list = parent.view?.proposals ?? []
  assert.equal(list.length, 2)
  assert.deepEqual(
    suggestions.slice(0, 2).map((entry) => entry.proposalId),
    list.map((entry) => entry.id),
  )
  assert.ok(list.every((entry) => entry.callId === call.id && entry.status === 'pending'))
  assert.equal(list[1]?.harness, 'pi')

  // 从卡片开始，换个 harness、不唤醒：子会话是换过的
  const second = list[1]
  assert.ok(second)
  const { sessionId } = (await world.channel.command('session.proposal.accept', {
    deviceId: 'local',
    sessionId: 's6',
    proposalId: second.id,
    overrides: { harness: 'claude', wakeParent: false },
  })) as { sessionId: string }
  await world.until(() => world.children('s6').some((entry) => entry.id === sessionId), '起出来了')
  const child = world.children('s6').find((entry) => entry.id === sessionId)
  assert.equal(child?.harness, 'claude')
  assert.equal(child?.lineage?.wakeParent, false)
  assert.equal(child?.lineage?.proposalId, second.id)

  // 提案那一出回答完调的是空的收尾：不画
  await say('提个子会话')
  const quiet = lastTurnItems().at(-1) as ToolCallItem
  assert.equal(quiet.tool, 'wrap_up')
  assert.deepEqual(quiet.wrapUp, { suggestions: [] })
  assert.equal(quietOf(quiet), true)
})

test('模拟：说“忘了收尾”回答完没调收尾，替它开一个提醒的回合，模型在里面补调收尾', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  const before = parent.view?.turns.length ?? 0
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '忘了收尾',
  })
  await world.until(
    () =>
      (parent.view?.turns.length ?? 0) === before + 2 &&
      parent.view?.turns.at(-1)?.status === 'completed',
    '提醒的回合结束',
  )
  const [asked, reminded] = (parent.view?.turns ?? []).slice(-2)
  const itemsOf = (ids: string[] | undefined) => (ids ?? []).map((id) => parent.view?.items[id])
  // 用户的回合里没有收尾
  assert.ok(itemsOf(asked?.itemIds).every((item) => item?.kind !== 'toolCall'))
  const [user, call] = itemsOf(reminded?.itemIds)
  assert.equal(user?.kind, 'userMessage')
  assert.deepEqual((user as UserMessageItem).event, { kind: 'remind', notes: [] })
  assert.equal((user as UserMessageItem).text, '')
  assert.equal((call as ToolCallItem).tool, 'wrap_up')
  assert.equal((call as ToolCallItem).wrapUp?.suggestions.length, 1)
  assert.equal(parent.view?.proposals.at(-1)?.callId, call?.id)
  // 提醒只一次：再等一会儿也不会再开回合
  const turns = parent.view?.turns.length
  world.time.advance(5000)
  await settle()
  assert.equal(parent.view?.turns.length, turns)
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
        (item) => item.kind === 'toolCall' && (item.agents?.length ?? 0) === 3,
      ),
    '子代理卡片',
  )
  const card = Object.values(parent.view?.items ?? {}).find(
    (item): item is ToolCallItem => item.kind === 'toolCall' && (item.agents?.length ?? 0) === 3,
  )
  const ids = card?.agents?.map((entry) => entry.threadId) ?? []
  assert.equal(ids.length, 3)
  // 子代理线程不进侧栏
  assert.ok(!(world.sidebar.view?.sessions ?? []).some((entry) => ids.includes(entry.id)))
  const views = ids.map((id) => world.watch(id))
  await world.until(() => views.every((view) => view.view !== null), '子线程打开了')
  assert.deepEqual(
    views.map((view) => view.view?.live),
    [true, false, false],
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
    [true, false, false],
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

test('模拟：子代理一个完成、一个被父会话停掉、一个失败；派出的条目不回写，状态以子线程为准', async () => {
  const world = mockWorld()
  await settle()
  const parent = world.watch('s6')
  await settle()
  await world.channel.command('session.send', {
    deviceId: 'local',
    sessionId: 's6',
    text: '用子代理看看',
  })
  const spawn = () =>
    Object.values(parent.view?.items ?? {}).find(
      (item): item is ToolCallItem => item.kind === 'toolCall' && (item.agents?.length ?? 0) === 3,
    )
  await world.until(() => spawn() !== undefined, '派出了三个')
  // 要停掉的那个一开始一直在跑（完成的那个在测试的时钟下可能当场就回完了）
  assert.equal(agentRunState(parent.view?.agents[1], null, null), 'running')
  await world.until(
    () => (parent.view?.agents ?? []).every((entry) => entry.turn?.state !== 'running'),
    '都停下了',
  )
  const states = (parent.view?.agents ?? []).map((entry) => [
    entry.description,
    agentRunState(entry, null, 'running'),
  ])
  assert.deepEqual(states, [
    ['走一遍仓库的目录结构', 'completed'],
    ['找出 core 里重复的工具函数', 'stopped'],
    ['对照 OpenCode 的 task 子会话', 'failed'],
  ])
  const failed = parent.view?.agents[2]
  assert.match(failed?.turn?.error ?? '', /PreToolUse:Agent hook error/)
  // 和真的 Claude 入口（改之前）、原生 codex 一样：派出的那一条一直报“在跑”，最后的状态在等待那一条上
  assert.deepEqual(
    spawn()?.agents?.map((entry) => entry.state),
    ['running', 'running', 'running'],
  )
  const wait = Object.values(parent.view?.items ?? {}).find(
    (item): item is ToolCallItem =>
      item.kind === 'toolCall' && typeof item.tool === 'object' && item.tool.key === 'collab.wait',
  )
  assert.deepEqual(
    wait?.agents?.map((entry) => entry.state),
    ['completed', 'interrupted', 'errored'],
  )
  const turnId = parent.view?.turns.at(-1)?.id ?? ''
  await world.until(
    () => parent.view?.turns.find((entry) => entry.id === turnId)?.status === 'completed',
    '父会话接着说完了',
  )
  const items = parent.view?.turns.find((entry) => entry.id === turnId)?.itemIds ?? []
  assert.equal(
    agentsUnfinished(
      items.map((id) => parent.view?.items[id]),
      parent.view?.agents,
    ),
    false,
  )
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

test('提案是不是那一条调用提的：条目键是“回合号:条目号”，提案记协议里的条目号', () => {
  assert.equal(proposedBy({ callId: 'call_1' }, 't1:call_1'), true)
  assert.equal(proposedBy({ callId: 'call_1' }, 'local:1:call_1'), true)
  assert.equal(proposedBy({ callId: 'call_1' }, 'call_1'), true)
  assert.equal(proposedBy({ callId: 'call_1' }, 't1:xcall_1'), false)
  assert.equal(proposedBy({ callId: null }, 't1:'), false)
  assert.equal(proposedBy({ callId: '' }, 't1:'), false)
})
