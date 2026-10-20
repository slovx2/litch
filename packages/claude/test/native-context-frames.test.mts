import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type ContextInjection,
  contextFrameBatches,
  parseContextItems,
  persistedContext,
} from '../src/native-context.mjs'
import { ProtocolError } from '../src/protocol-contract.mjs'

// thread/inject_items 的条目怎么变成原生消息、分几批送给 CLI、落了一半时从哪接着送。
const text = (role: 'user' | 'assistant', value: string) => ({
  type: 'message',
  role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: value }],
})

function injection(roles: Array<'user' | 'assistant'>): ContextInjection {
  return {
    threadId: 'th',
    cwd: '/work',
    model: null,
    sessionId: 'session',
    existingSession: true,
    messageId: 'batch',
    messages: roles.map((role, index) => ({
      uuid: `${role}-${index}`,
      role,
      content: [{ type: 'text', text: `${role}-${index}` }],
    })),
  }
}

const shape = (batches: ReturnType<typeof contextFrameBatches>) =>
  batches.map((batch) =>
    batch.map((frame: any) =>
      frame.type === 'user' && frame.message.content.length === 0 ? 'commit' : frame.uuid,
    ),
  )

test('注入条目：相邻同角色合成一条，assistant 只收 output_text', () => {
  const messages = parseContextItems([
    text('assistant', 'a1'),
    text('assistant', 'a2'),
    text('user', 'u1'),
    text('assistant', 'a3'),
  ])
  assert.deepEqual(messages, [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a1' },
        { type: 'text', text: 'a2' },
      ],
    },
    { role: 'user', content: [{ type: 'text', text: 'u1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a3' }] },
  ])
  assert.throws(
    () =>
      parseContextItems([
        { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'x' }] },
      ]),
    ProtocolError,
  )
})

test('输入帧分批：user 后面还有 assistant 就断开等它落盘；以 assistant 收尾补空 user；可从中间接着送', () => {
  assert.deepEqual(shape(contextFrameBatches(injection(['user']))), [['user-0']])
  assert.deepEqual(shape(contextFrameBatches(injection(['assistant']))), [
    ['assistant-0', 'commit'],
  ])
  const mixed = injection(['user', 'assistant', 'user', 'assistant'])
  assert.deepEqual(shape(contextFrameBatches(mixed)), [
    ['user-0'],
    ['assistant-1', 'user-2'],
    ['assistant-3', 'commit'],
  ])
  assert.deepEqual(shape(contextFrameBatches(mixed, 1)), [
    ['assistant-1', 'user-2'],
    ['assistant-3', 'commit'],
  ])
  const [assistant] = contextFrameBatches(injection(['assistant']))[0] as any[]
  assert.equal(assistant.type, 'assistant')
  assert.equal(assistant.session_id, 'session')
  assert.equal(assistant.message.role, 'assistant')
})

test('落盘对账：开头落了几条从下一条接着送；内容不一致或顺序乱了拒绝重放', async () => {
  const context = injection(['user', 'assistant', 'user'])
  const sdk = (entries: Array<{ uuid: string; type: string; text?: string }>) =>
    ({
      getSessionMessages: async () =>
        entries.map((entry) => ({
          uuid: entry.uuid,
          type: entry.type,
          message: {
            role: entry.type,
            content: [{ type: 'text', text: entry.text ?? entry.uuid }],
          },
        })),
    }) as any
  assert.deepEqual(await persistedContext(sdk([{ uuid: 'earlier', type: 'user' }]), context), {
    count: 0,
    boundary: 'earlier',
  })
  assert.deepEqual(await persistedContext(sdk([{ uuid: 'user-0', type: 'user' }]), context), {
    count: 1,
    boundary: 'user-0',
  })
  assert.equal(
    (
      await persistedContext(
        sdk([
          { uuid: 'user-0', type: 'user' },
          { uuid: 'assistant-1', type: 'assistant' },
          { uuid: 'user-2', type: 'user' },
        ]),
        context,
      )
    ).count,
    3,
  )
  await assert.rejects(
    persistedContext(sdk([{ uuid: 'assistant-1', type: 'assistant' }]), context),
    /顺序不对/,
  )
  await assert.rejects(
    persistedContext(sdk([{ uuid: 'user-0', type: 'user', text: 'other' }]), context),
    /持久内容不一致/,
  )
})
