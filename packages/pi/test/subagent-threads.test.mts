import assert from 'node:assert/strict'
import test from 'node:test'
import { projectHistory, SUBAGENT_THREAD_ENTRY } from '../src/projection.mjs'
import type { PiThread } from '../src/store.mjs'

const spawn = (callId: string, agentId: string, at: number) => [
  {
    type: 'message',
    id: `call-${callId}`,
    message: {
      role: 'assistant',
      timestamp: at,
      content: [
        {
          type: 'toolCall',
          id: callId,
          name: 'subagent',
          arguments: { subagent_type: 'Explore', prompt: `do ${callId}`, run_in_background: true },
        },
      ],
    },
  },
  {
    type: 'message',
    id: `result-${callId}`,
    message: {
      role: 'toolResult',
      timestamp: at + 1,
      toolCallId: callId,
      content: [{ type: 'text', text: 'Agent started in background.' }],
      details: { agentId, status: 'background' },
    },
  },
]

test('重新载入历史：子代理条目按父会话里记的配对指向子线程，配不上的（子会话没建成）留着 agentId', () => {
  const entries = [
    ...spawn('call-a', 'agent-a', 1),
    ...spawn('call-b', 'agent-b', 10),
    // 后台子代理的子会话在工具结果之后才建，配对记在后面
    {
      type: 'custom',
      customType: SUBAGENT_THREAD_ENTRY,
      data: { agentId: 'agent-a', threadId: 'thread-a' },
    },
    {
      type: 'custom',
      customType: 'subagents:record',
      data: { id: 'agent-a', status: 'completed', result: 'a done' },
    },
    {
      type: 'custom',
      customType: 'subagents:record',
      data: { id: 'agent-b', status: 'error', error: 'model missing' },
    },
  ]
  const turns = projectHistory(entries, { id: 'parent', cwd: '/tmp' } as PiThread)
  const items = turns.flatMap((turn) => turn.items).filter((i) => i.type === 'collabAgentToolCall')
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].receiverThreadIds, ['thread-a'])
  assert.deepEqual(items[0].agentsStates, {
    'thread-a': { status: 'completed', message: 'a done' },
  })
  assert.deepEqual(items[1].receiverThreadIds, ['agent-b'])
  assert.deepEqual(items[1].agentsStates, {
    'agent-b': { status: 'errored', message: 'model missing' },
  })
})
