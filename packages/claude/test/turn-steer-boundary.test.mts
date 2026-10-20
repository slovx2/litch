import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProtocolError } from '../src/protocol-contract.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RpcPeer } from '../src/types.mjs'

// 回合正在收尾时运行时不再收插话（和上游 codex 一样，收尾中的回合拒绝 steer）。入口这时要回错误，
// 而且这句话不能留在回合里、也不能被记成已收下：同一个消息号重试照样回错误，不会假装成功。
test('STEER-BOUNDARY-001：运行时拒绝插话时，turn/steer 回错误，回合里不留这句话，重试也不算收下', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-steer-boundary-'))
  const previousHome = process.env.CHA_CLAUDE_HOME
  process.env.CHA_CLAUDE_HOME = directory
  const store = new SessionStore(join(directory, 'state.sqlite'))
  const responses = new Map<unknown, any>()
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let steers = 0
  const runtime: ClaudeRuntime = {
    runTurn: async (_context, handlers) => {
      started()
      await released
      await handlers.onEvent({ type: 'completed', success: true, result: 'done' })
    },
    steer: async () => {
      steers++
      throw new ProtocolError(-32009, '原生回合未启动或已结束')
    },
    interrupt: async () => {},
    stop: async () => {},
  }
  const server = new CodexClaudeAppServer(store, runtime)
  let completed!: () => void
  const finished = new Promise<void>((resolve) => {
    completed = resolve
  })
  const peer: RpcPeer = {
    id: 'steer-boundary-test',
    close: () => {},
    send: (message) => {
      if ('id' in message) responses.set(message.id, message)
      if ('method' in message && message.method === 'turn/completed') completed()
    },
  }
  let nextId = 0
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = ++nextId
    await server.handle(peer, { id, method, params })
    const response = responses.get(id)
    assert.ok(response, `Missing ${method} response`)
    return response
  }
  try {
    const { thread } = (await call('thread/start', { cwd: directory, model: 'sonnet' })).result
    const { turn } = (
      await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: '开始' }] })
    ).result
    await running
    const steer = {
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: 'late-message',
      input: [{ type: 'text', text: 'LATE_STEER' }],
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await call('turn/steer', steer)
      assert.equal(response.error?.code, -32009, JSON.stringify(response))
    }
    assert.equal(steers, 2, '重试不能因为记过这个消息号就直接回成功')
    release()
    await finished
    const read = (await call('thread/read', { threadId: thread.id, includeTurns: true })).result
    assert.doesNotMatch(JSON.stringify(read.thread.turns), /LATE_STEER/)
  } finally {
    release()
    await server.stop()
    if (previousHome == null) delete process.env.CHA_CLAUDE_HOME
    else process.env.CHA_CLAUDE_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
