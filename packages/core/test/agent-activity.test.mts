// 原生 Codex 的活动标记和各适配器的协作调用共用子代理行，不重复、不错报状态。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ThreadItem } from '../../protocol/src/index.mjs'
import {
  agentRowShown,
  agentRunState,
  agentStatesOf,
  agentsUnfinished,
  blockInput,
  bucketItems,
  cardPlace,
  processTally,
  projectItem,
  type ToolCallItem,
} from '../src/index.mjs'

const activity = (
  id: string,
  kind: 'started' | 'interacted' | 'completed' | 'interrupted',
  child = 'a',
) =>
  projectItem({
    type: 'subAgentActivity',
    model: null,
    reasoningEffort: null,
    id,
    kind,
    agentThreadId: child,
    agentPath: `/root/${child}`,
  }) as ToolCallItem

const spawn = (ids: string[]) =>
  projectItem({
    type: 'collabAgentToolCall',
    id: 'spawn',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'parent',
    receiverThreadIds: ids,
    prompt: '审核代码',
    model: null,
    reasoningEffort: null,
    agentsStates: Object.fromEntries(ids.map((id) => [id, { status: 'running', message: null }])),
  } as ThreadItem) as ToolCallItem

test('Codex 活动使用可打开子线程的紧凑行，状态来自活动而不是条目完成事件', () => {
  const states = {
    started: 'running',
    interacted: 'running',
    completed: 'completed',
    interrupted: 'stopped',
  } as const
  for (const kind of Object.keys(states) as (keyof typeof states)[]) {
    const item = activity(kind, kind, 'review_scroll_fix')
    assert.equal(item.kind, 'toolCall')
    assert.equal(cardPlace(item), 'inline')
    assert.equal(item.agentActivity?.name, 'review_scroll_fix')
    assert.equal(item.agents?.[0]?.threadId, 'review_scroll_fix')
    assert.equal(agentRunState(undefined, undefined, item.agents?.[0]?.state), states[kind])
    const blocks = bucketItems([blockInput(item.id, item)])
    assert.deepEqual(blocks, [
      { type: 'process', key: item.id, parts: [{ type: 'card', itemId: item.id }] },
    ])
  }
})

test('只有活动标记：后续状态更新第一行，完成和打断不会重复计数或一直显示进行中', () => {
  const start = activity('start', 'started')
  const interacted = activity('send', 'interacted')
  const done = activity('done', 'completed')
  const other = activity('other', 'interrupted', 'b')
  const items = [start, interacted, done, other]
  assert.deepEqual(
    items.filter((item) => agentRowShown(item, items)).map((item) => item.id),
    ['start', 'other'],
  )
  assert.equal(agentStatesOf(items).get('a'), 'completed')
  assert.equal(agentsUnfinished([start], []), true)
  assert.equal(agentsUnfinished(items, []), false)
  assert.equal(processTally(items).agents, 2)
  assert.equal(processTally(items).steps, 0)
})

test('调用和活动标记混合：无论顺序，保留派出调用的行和任务说明', () => {
  const call = spawn(['a', 'b'])
  const markers = [activity('a', 'started'), activity('b', 'started', 'b')]
  for (const items of [
    [call, ...markers],
    [...markers, call],
  ]) {
    assert.deepEqual(
      items.filter((item) => agentRowShown(item, items)).map((item) => item.id),
      ['spawn'],
    )
    assert.equal(processTally(items).agents, 2)
  }
  // 派出调用先开始、接收方随后才填上；届时活动行应立即让位，不等新条目。
  const pending = spawn([])
  const marker = markers[0]
  assert.ok(marker)
  assert.equal(agentRowShown(marker, [pending, ...markers]), true)
  assert.equal(agentRowShown(marker, [call, ...markers]), false)
})

test('Claude/Pi/DSH/OpenCode 共用的协作条目不变；活动不覆盖子线程报的失败', () => {
  const call = spawn(['a'])
  assert.equal(cardPlace(call), 'inline')
  assert.equal(agentRowShown(call, [call]), true)
  const done = activity('done', 'completed')
  const failed = {
    status: 'idle' as const,
    turn: { state: 'failed' as const, startedAt: 1, durationMs: 2, error: '出错原文' },
  }
  assert.equal(agentRunState(failed, agentStatesOf([done]).get('a'), 'running'), 'failed')
})
