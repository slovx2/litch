// 引擎自己的子代理的状态：五种状态的推导（子线程自己的回合优先，其次同一回合里协作条目报的，最后才是派出时的快照）、
// “这个回合里还有没做完的子代理”、一句话描述；设备记着子线程的回合并交给开着的父会话；模拟核心演的三种结局。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type AgentThreadView,
  agentRunState,
  agentStatesOf,
  agentsUnfinished,
  type ItemView,
  type ToolCallItem,
} from '../src/index.mjs'
import { projectItem } from '../src/projection/items.mjs'
import { firstSentence, projectAgentThread } from '../src/projection/tree.mjs'
import { deviceWorld, features } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

/** 一次协作调用的条目（派出、等待……），states 是对面报的各个子线程的状态 */
const collab = (
  id: string,
  tool: 'spawnAgent' | 'wait',
  states: Record<string, string>,
  status = 'completed',
): ToolCallItem =>
  projectItem({
    type: 'collabAgentToolCall',
    id,
    tool,
    status,
    senderThreadId: 'p',
    receiverThreadIds: Object.keys(states),
    prompt: tool === 'spawnAgent' ? '分头看看' : null,
    model: null,
    reasoningEffort: null,
    agentsStates: Object.fromEntries(
      Object.entries(states).map(([key, value]) => [key, { status: value, message: null }]),
    ),
  } as never) as ToolCallItem

/** 列表里的一个子代理：状态和最近的回合 */
const agent = (
  id: string,
  status: AgentThreadView['status'],
  last: AgentThreadView['turn'],
): AgentThreadView => ({
  id,
  parentId: 'p',
  nickname: null,
  role: null,
  description: '',
  prompt: '',
  status,
  turn: last,
  canInput: null,
  updatedAt: 0,
})

const ended = (state: 'completed' | 'failed' | 'stopped'): AgentThreadView['turn'] => ({
  state,
  startedAt: 1,
  durationMs: 2,
  error: state === 'failed' ? '原话' : null,
})

test('状态：协议的七种归成五种（排队、进行中、完成、失败、已停止）', () => {
  assert.equal(agentRunState(null, null, 'pendingInit'), 'queued')
  assert.equal(agentRunState(null, null, 'running'), 'running')
  assert.equal(agentRunState(null, null, 'completed'), 'completed')
  assert.equal(agentRunState(null, null, 'errored'), 'failed')
  assert.equal(agentRunState(null, null, 'notFound'), 'failed')
  assert.equal(agentRunState(null, null, 'interrupted'), 'stopped')
  assert.equal(agentRunState(null, null, 'shutdown'), 'stopped')
  // 什么都不知道：刚派出、对面还没说是谁
  assert.equal(agentRunState(null, null, null), 'queued')
})

test('状态：派出时的快照是“在跑”、子线程已经做完或失败或被停掉时，以子线程为准（跑完了还显示在跑的缺陷）', () => {
  assert.equal(agentRunState(agent('a', 'idle', ended('completed')), null, 'running'), 'completed')
  assert.equal(agentRunState(agent('a', 'idle', ended('failed')), null, 'running'), 'failed')
  assert.equal(agentRunState(agent('a', 'idle', ended('stopped')), null, 'running'), 'stopped')
  // 子线程比同一回合里后来的等待条目更准：等待报的完成之后又给它派了活、正在跑
  const again = agent('a', 'running', {
    state: 'running',
    startedAt: 5,
    durationMs: null,
    error: null,
  })
  assert.equal(agentRunState(again, 'completed', 'running'), 'running')
  // 状态是“在跑”但回合还没报（回合开始的通知还没到）也算进行中
  assert.equal(
    agentRunState(agent('a', 'running', ended('completed')), null, 'completed'),
    'running',
  )
})

test('状态：子线程说不出来（没载入、对面没给回合）时，看同一回合里后面的协作条目，再看快照', () => {
  const unknown = agent('a', 'idle', null)
  assert.equal(agentRunState(unknown, 'completed', 'running'), 'completed')
  assert.equal(agentRunState(unknown, null, 'running'), 'running')
  const items: ItemView[] = [
    collab('s', 'spawnAgent', { a: 'running', b: 'running' }),
    collab('w', 'wait', { a: 'completed' }),
    // 还在等的那一条没报状态：不盖掉前面的
    collab('w2', 'wait', {}, 'inProgress'),
  ]
  const reported = agentStatesOf(items)
  assert.equal(reported.get('a'), 'completed')
  assert.equal(reported.get('b'), 'running')
})

test('没做完的子代理：有排队、进行中的就算；都完成、失败、停掉了就不算；派出的调用还没结束也算', () => {
  const spawn = collab('s', 'spawnAgent', { a: 'running', b: 'running' })
  assert.equal(agentsUnfinished([spawn], []), true)
  // 子线程一个完成、一个失败
  const done = [agent('a', 'idle', ended('completed')), agent('b', 'idle', ended('failed'))]
  assert.equal(agentsUnfinished([spawn], done), false)
  // 不知道子线程的，看等待条目报的
  assert.equal(
    agentsUnfinished([spawn, collab('w', 'wait', { a: 'completed', b: 'interrupted' })], null),
    false,
  )
  assert.equal(
    agentsUnfinished([spawn, collab('w', 'wait', { a: 'completed' })], [agent('b', 'idle', null)]),
    true,
  )
  // 刚开始派、还不知道派了谁
  assert.equal(agentsUnfinished([collab('s', 'spawnAgent', {}, 'inProgress')], null), true)
  // 回合里没有派出子代理
  assert.equal(agentsUnfinished([collab('w', 'wait', { a: 'running' })], null), false)
})

test('描述：有名字用名字（Claude 入口放的是 Agent 工具的 description），没有的取任务说明的第一句', () => {
  assert.equal(firstSentence('把仓库走一遍。说说每个包是干什么的'), '把仓库走一遍')
  assert.equal(firstSentence('\n  Walk the repo. Then report.'), 'Walk the repo')
  assert.equal(firstSentence('v1.2 的版本号要不要升'), 'v1.2 的版本号要不要升')
  assert.equal(Array.from(firstSentence('字'.repeat(60))).length, 41)
  const named = projectAgentThread(
    thread({
      id: 'a',
      parentThreadId: 'p',
      name: '读取探针文件',
      preview: 'SUBAGENT_CHILD 读取 a.txt',
    }),
  )
  assert.equal(named.description, '读取探针文件')
  assert.equal(named.prompt, 'SUBAGENT_CHILD 读取 a.txt')
  assert.equal(named.parentId, 'p')
  const bare = projectAgentThread(
    thread({
      id: 'b',
      parentThreadId: 'p',
      preview: '找出重复的代码。列出路径。',
      turns: [turn('t', [], { status: 'failed', error: { message: '拦下了' } as never })],
    }),
  )
  assert.equal(bare.description, '找出重复的代码')
  assert.deepEqual(bare.turn, {
    state: 'failed',
    startedAt: 1_700_000_100_000,
    durationMs: 30_000,
    error: '拦下了',
  })
})

function agentsWorld() {
  const codex = harness('codex', {
    declaration: { extensions: [], features: features() },
    threads: [
      thread({
        id: 'p',
        updatedAt: 1_700_000_300,
        turns: [turn('t1', [userText('u1', '分头做')])],
      }),
      // 一个已经失败了（回合要另外问），一个还没有回合
      thread({
        id: 'ag1',
        updatedAt: 1_700_000_200,
        parentThreadId: 'p',
        name: '对照 OpenCode',
        turns: [
          turn('ta', [], {
            status: 'failed',
            error: { message: 'PreToolUse:Agent hook error' } as never,
          }),
        ],
      }),
      thread({ id: 'ag2', updatedAt: 1_700_000_100, parentThreadId: 'p', preview: '走一遍目录。' }),
    ],
  })
  return deviceWorld([codex])
}

test('设备：列子代理时问每个子线程最近的一个回合；子线程的回合开始、结束交给开着的父会话', async () => {
  const world = agentsWorld()
  world.core.start()
  await settle()
  const parent = watchSession(world.core, 'p')
  await settle()
  const { agents } = (await world.command('session.agents', { sessionId: 'p' })) as {
    agents: AgentThreadView[]
  }
  assert.deepEqual(
    agents.map((entry) => [entry.id, entry.description, entry.turn?.state ?? null]),
    [
      ['ag1', '对照 OpenCode', 'failed'],
      ['ag2', '走一遍目录', null],
    ],
  )
  assert.equal(agents[0]?.turn?.error, 'PreToolUse:Agent hook error')
  assert.deepEqual(
    world.sent('thread/turns/list').map((params) => [params.threadId, params.limit]),
    [
      ['ag1', 1],
      ['ag2', 1],
    ],
  )
  await settle()
  assert.equal(parent.seen.view?.agents.length, 2)

  // ag2 开始跑、跑完：父会话的子代理列表跟着变，不用再问
  const running = turn('tb', [], { status: 'inProgress', completedAt: null, durationMs: null })
  world.peer.last().notify('turn/started', { threadId: 'ag2', turn: running })
  await settle()
  const live = parent.seen.view?.agents.find((entry) => entry.id === 'ag2')
  assert.equal(live?.turn?.state, 'running')
  assert.equal(agentRunState(live, null, 'running'), 'running')
  world.peer.last().notify('turn/completed', {
    threadId: 'ag2',
    turn: { ...running, status: 'completed', durationMs: 4200 },
  })
  await settle()
  const finished = parent.seen.view?.agents.find((entry) => entry.id === 'ag2')
  assert.deepEqual(finished?.turn, {
    state: 'completed',
    startedAt: 1_700_000_100_000,
    durationMs: 4200,
    error: null,
  })
  // 派出时的快照停在“在跑”也显示完成
  assert.equal(agentRunState(finished, null, 'running'), 'completed')
  parent.close()
})
