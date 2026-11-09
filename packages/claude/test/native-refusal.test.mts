import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { claudeRefusalError, claudeRefusalOf } from '../../protocol/src/claude-refusal.mjs'
import { projectNativeHistory } from '../src/native-history.mjs'
import { NativeClaudeRuntime } from '../src/native-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, RuntimeEvent, RuntimeTurnContext, WireMessage } from '../src/types.mjs'

// 虚构原文，不含用户任务、账号或请求标识。
const raw =
  'API Error: Example model safeguards flagged this message. Please revise this sample request.'
const refusal = {
  type: 'assistant',
  uuid: 'refusal',
  timestamp: '2026-01-01T00:00:01Z',
  error: 'invalid_request',
  isApiErrorMessage: true,
  message: {
    id: 'sample-message',
    role: 'assistant',
    stop_reason: 'refusal',
    content: [{ type: 'text', text: raw }],
  },
}
const context: RuntimeTurnContext = {
  threadId: 'sample',
  turnId: 'sample-turn',
  prompt: 'sample',
  cwd: process.cwd(),
  runtimeType: null,
  model: null,
  effort: null,
  claudeSessionId: null,
  forkSession: false,
  mcpServers: null,
  allowedTools: null,
  addDirs: [],
  outputFormat: null,
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  systemPromptAddendum: null,
  planMode: false,
  imageInputs: [],
}

function runtime(messages: Record<string, unknown>[]) {
  const result = new NativeClaudeRuntime()
  Reflect.set(result, 'sdk', {
    query: async function* () {
      yield* messages
    },
  })
  return result
}

for (const [label, messages] of [
  ['assistant + success result', [refusal, { type: 'result', subtype: 'success', result: 'done' }]],
  [
    'assistant + empty refusal result',
    [refusal, { type: 'result', subtype: 'success', stop_reason: 'refusal', result: '' }],
  ],
  [
    'stream refusal + empty assistant',
    [
      { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'refusal' } } },
      { type: 'result', subtype: 'success', result: '' },
    ],
  ],
  ['result refusal', [{ type: 'result', subtype: 'success', stop_reason: 'refusal', result: raw }]],
  [
    'result errors',
    [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
        errors: [raw],
      },
    ],
  ],
] as const) {
  test(`安全拦截以失败收尾：${label}`, async () => {
    const native = runtime([...messages])
    const events: RuntimeEvent[] = []
    try {
      await assert.rejects(
        native.runTurn(context, {
          onEvent: (event) => {
            events.push(event)
          },
          onPermissionRequest: async () => ({ decision: 'accept' }),
          onUserInputRequest: async () => ({ answers: {} }),
        }),
        /Blocked by Claude safety policy/,
      )
      const completed = events.findLast((event) => event.type === 'completed')
      assert.equal(completed?.type, 'completed')
      if (completed?.type !== 'completed') return
      assert.equal(completed.success, false)
      assert.match(completed.result ?? '', /Blocked by Claude safety policy/)
      if (label !== 'stream refusal + empty assistant') assert.ok(completed.result?.includes(raw))
    } finally {
      await native.stop()
    }
  })
}

test('普通正文提及策略不误判；子代理 refusal 不把成功的父回合标失败', async () => {
  assert.equal(
    claudeRefusalOf({ type: 'assistant', message: { content: [{ type: 'text', text: raw }] } }),
    null,
  )
  const native = runtime([
    { ...refusal, parent_tool_use_id: 'child' },
    { type: 'result', subtype: 'success', result: 'done' },
  ])
  const events: RuntimeEvent[] = []
  try {
    await native.runTurn(context, {
      onEvent: (event) => {
        events.push(event)
      },
      onPermissionRequest: async () => ({ decision: 'accept' }),
      onUserInputRequest: async () => ({ answers: {} }),
    })
    assert.equal(events.findLast((event) => event.type === 'completed')?.success, true)
  } finally {
    await native.stop()
  }
})

test('原生历史 refusal 生成失败和原文，记录仍在被进程占用也不复活成 running', () => {
  const messages = [
    {
      type: 'user',
      uuid: 'user',
      timestamp: '2026-01-01T00:00:00Z',
      message: { content: '虚构任务' },
    },
    refusal,
  ]
  for (const running of [false, true]) {
    const { turns } = projectNativeHistory('sample', messages, '/work/example', { running })
    assert.equal(turns[0]?.status, 'failed')
    assert.deepEqual(turns[0]?.error, { message: claudeRefusalError(raw), codexErrorInfo: 'other' })
    assert.equal(turns[0]?.durationMs, 1000)
  }
})

test('实时失败广播错误状态；重开和元数据读取保留错误，下一回合可正常完成', async () => {
  const home = await mkdtemp(join(tmpdir(), 'refusal-test-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const script: Record<string, unknown>[] = [
    refusal,
    { type: 'result', subtype: 'success', result: 'done' },
  ]
  const native = runtime(script)
  const server = new CodexClaudeAppServer(store, native)
  const messages: WireMessage[] = []
  const peer: RpcPeer = {
    id: 'refusal-test',
    close() {},
    send: (message) => {
      messages.push(message)
    },
  }
  let seq = 0
  const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++seq
    await server.handle(peer, { id, method, params })
    const result = messages.find((message) => 'id' in message && message.id === id) as any
    assert.equal(result?.error, undefined, JSON.stringify(result))
    return result.result
  }
  try {
    const { thread } = await call('thread/start', { cwd: home })
    const { turn } = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '虚构任务' }],
    })
    for (let n = 0; n < 300 && store.getTurn(turn.id)?.status === 'inProgress'; n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(store.getTurn(turn.id)?.status, 'failed')
    assert.ok(
      messages.some(
        (message) =>
          'method' in message &&
          message.method === 'thread/status/changed' &&
          (message.params as any).status.type === 'systemError',
      ),
    )
    assert.equal(
      (await call('thread/read', { threadId: thread.id, includeTurns: false })).thread.status.type,
      'systemError',
    )
    // 库中已有的原始 API 错误也按末回合状态投影，无需修改用户历史。
    const persisted = store.getTurn(turn.id)
    assert.ok(persisted)
    store.upsertTurn({ ...persisted, error: { message: raw, codexErrorInfo: 'other' } })
    store.updateThreadStatus(thread.id, { type: 'idle' })
    assert.equal(
      (await call('thread/read', { threadId: thread.id, includeTurns: false })).thread.status.type,
      'systemError',
    )
    script.splice(0, script.length, { type: 'result', subtype: 'success', result: 'done' })
    const next = await call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '新的虚构任务' }],
    })
    for (let n = 0; n < 300 && store.getTurn(next.turn.id)?.status === 'inProgress'; n++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(store.getTurn(next.turn.id)?.status, 'completed')
    assert.equal(
      (await call('thread/read', { threadId: thread.id, includeTurns: false })).thread.status.type,
      'idle',
    )
  } finally {
    await server.stop()
    await rm(home, { recursive: true, force: true })
  }
})
