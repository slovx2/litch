// 真正的协议层与 SQLite，运行时用无凭据替身记录每个回合收到的设置。
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer, RuntimeTurnContext } from '../src/types.mjs'

test('Claude 会话切换立即存盘，重启后无参数的任务、回报、后台和经理事件回合沿用新设置', {
  timeout: 15_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'claude-persist-settings-'))
  const previous = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = home
  const path = join(home, 'state.sqlite')
  const calls: RuntimeTurnContext[] = []
  const runtime: ClaudeRuntime = {
    async runTurn(context, handlers) {
      calls.push(context)
      await handlers.onEvent({ type: 'completed', success: true })
    },
    async steer() {},
    async interrupt() {},
    async stop() {},
  }
  let server = new CodexClaudeAppServer(new SessionStore(path), runtime)
  const responses = new Map<unknown, any>()
  const ended = new Set<string>()
  const peer: RpcPeer = {
    id: 'isolated-settings',
    close() {},
    send(message) {
      if ('id' in message) responses.set(message.id, message)
      if ('method' in message && message.method === 'turn/completed')
        ended.add((message.params as any).turn.id)
    },
  }
  let nextId = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    await server.handle(peer, { id, method, params })
    const response = responses.get(id)
    assert.ok(response, method)
    assert.equal(response.error, undefined, JSON.stringify(response.error))
    return response.result
  }
  try {
    const { thread } = await request('thread/start', { cwd: home, model: 'sonnet', effort: 'low' })
    await request('thread/settings/update', {
      threadId: thread.id,
      model: 'opus',
      effort: 'high',
      permissions: ':danger-full-access',
      collaborationMode: { mode: 'plan', settings: { model: 'opus', reasoning_effort: 'high' } },
    })
    assert.equal(calls.length, 0, '不用先发一条用户消息')
    await server.stop()
    server = new CodexClaudeAppServer(new SessionStore(path), runtime)
    const resumed = await request('thread/resume', { threadId: thread.id, excludeTurns: true })
    assert.equal(resumed.model, 'opus')
    assert.equal(resumed.reasoningEffort, 'high')
    for (const source of ['定时任务', '子会话回报', '后台完成', '经理事件', '用户']) {
      const { turn } = await request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: source }],
      })
      const deadline = Date.now() + 3000
      while (!ended.has(turn.id) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(ended.has(turn.id), `${source}回合应完成`)
      const context = calls.at(-1)
      assert.equal(context?.effort, 'high', source)
      assert.equal(context?.model, 'opus', source)
      assert.equal(context?.sandboxMode, 'danger-full-access', source)
      assert.equal(context?.approvalPolicy, 'never', source)
      assert.equal(context?.planMode, true, source)
    }
    assert.equal(calls.length, 5)
  } finally {
    await server.stop()
    if (previous === undefined) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previous
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
