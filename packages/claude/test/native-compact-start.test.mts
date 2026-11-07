import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import type { RuntimeEvent, RuntimeTurnContext } from '../src/types.mjs'

const context: RuntimeTurnContext = {
  threadId: 'cold-compact',
  turnId: 'compact',
  purpose: 'compact',
  prompt: '/compact',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: 'resumed',
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'read-only',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

test('冷启动压缩先收到后台通知的空 result，必须继续等自己的命令', async () => {
  const runtime = new NativeClaudeRuntime()
  const events: RuntimeEvent[] = []
  let commandId: unknown
  Reflect.set(runtime, 'sdk', {
    query: async function* ({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) {
      const input = await prompt[Symbol.asyncIterator]().next()
      commandId = input.value?.uuid
      yield { type: 'system', subtype: 'session_state_changed', state: 'running' }
      yield {
        type: 'result',
        subtype: 'success',
        origin: { kind: 'task-notification' },
        num_turns: 0,
      }
      await assert.rejects(runtime.steer(context.threadId, '子会话回报'), /正在压缩上下文/)
      // 日志中的先后顺序：先处理恢复出来的后台任务，然后才轮到 /compact。
      yield {
        type: 'system',
        subtype: 'command_lifecycle',
        state: 'started',
        command_uuid: commandId,
      }
      yield { type: 'system', subtype: 'compact_boundary', uuid: 'compact-boundary' }
      yield {
        type: 'system',
        subtype: 'command_lifecycle',
        state: 'completed',
        command_uuid: commandId,
      }
      yield { type: 'result', subtype: 'success', origin: { kind: 'human' }, num_turns: 0 }
    },
  })
  await runtime.runTurn(context, {
    onEvent: async (event) => {
      events.push(event)
    },
    onPermissionRequest: async () => ({ decision: 'accept' }),
    onUserInputRequest: async () => ({ answers: {} }),
  })
  assert.equal(typeof commandId, 'string')
  const done = events.findIndex((event) => event.type === 'completed')
  const boundary = events.findIndex((event) => event.type === 'context_compacted')
  assert.ok(boundary >= 0 && done > boundary, '后台通知不能抢先结束压缩回合')
})
