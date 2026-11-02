import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { ClaudeRuntime, RuntimeHandlers } from '../src/types.mjs'
import { Connection } from './fixtures/in-process.mjs'

test('INPUT-DELIVERY：取消回执在 interrupted 后仍能落库；按投递连接隔离扩展', async () => {
  const directory = await mkdtemp('/tmp/litch-input-wire-')
  const store = new SessionStore(`${directory}/state.sqlite`)
  let handlers!: RuntimeHandlers
  let release!: () => void
  let ready!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const ended = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending: string[] = []
  const runtime: ClaudeRuntime = {
    runTurn: async (_context, current) => {
      handlers = current
      ready()
      await ended
    },
    steer: async (_threadId, _text, uuid) => {
      pending.push(uuid!)
      await handlers.onEvent({ type: 'input_delivery', messageId: uuid!, status: 'queued' })
    },
    interrupt: async () => {
      for (const messageId of pending)
        await handlers.onEvent({ type: 'input_delivery', messageId, status: 'held' })
      release()
    },
    stop: async () => {
      release()
    },
  }
  const server = new CodexClaudeAppServer(store, runtime)
  const aware = new Connection(server, 'aware')
  const plain = new Connection(server, 'plain')
  try {
    for (const [connection, capabilities] of [
      [aware, { litchExtensions: ['inputDelivery'] }],
      [plain, {}],
    ] as const)
      await connection.request('initialize', {
        clientInfo: { name: connection.name, version: '1', title: null },
        capabilities,
      })
    const { thread } = await aware.request('thread/start', { cwd: directory, model: 'sonnet' })
    await plain.request('thread/resume', { threadId: thread.id })
    const { turn } = await aware.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '运行' }],
    })
    await started
    await aware.request('turn/steer', {
      threadId: thread.id,
      expectedTurnId: turn.id,
      clientUserMessageId: 'pending',
      input: [{ type: 'text', text: '未消费' }],
    })
    assert.ok(
      aware
        .notifications('item/completed')
        .some((event) => event.params.item.litchInputDelivery === 'queued'),
    )
    assert.ok(
      !plain
        .notifications('item/completed')
        .some((event) => event.params.item.clientId === 'pending'),
    )
    await aware.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    const view = await aware.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(
      view.thread.turns[0].items.find((item: any) => item.clientId === 'pending')
        .litchInputDelivery,
      'held',
    )
    assert.equal(view.thread.turns[0].status, 'interrupted')
    const cancelled = view.thread.turns[0].items.find((item: any) => item.clientId === 'pending')
    for (const status of ['unknown', 'queued'] as const) {
      await handlers.onEvent({ type: 'input_delivery', messageId: cancelled.id, status })
      const saved = await aware.request('thread/read', { threadId: thread.id, includeTurns: true })
      assert.equal(
        saved.thread.turns[0].items.find((item: any) => item.id === cancelled.id)
          .litchInputDelivery,
        'held',
      )
    }

    const standard = await plain.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.doesNotMatch(JSON.stringify(standard), /litchInputDelivery/)
    assert.doesNotMatch(JSON.stringify(plain.trace), /litchInputDelivery/)
    const again = await aware.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(
      again.thread.turns[0].items.find((item: any) => item.clientId === 'pending')
        .litchInputDelivery,
      'held',
    )
    // 更强的原生接纳证据优先，迟到取消/排队不能再把它退回。
    await handlers.onEvent({ type: 'input_delivery', messageId: cancelled.id, status: 'sent' })
    for (const status of ['held', 'unknown', 'queued'] as const)
      await handlers.onEvent({ type: 'input_delivery', messageId: cancelled.id, status })
    const settled = await aware.request('thread/read', { threadId: thread.id, includeTurns: true })
    assert.equal(
      settled.thread.turns[0].items.find((item: any) => item.id === cancelled.id)
        .litchInputDelivery,
      'sent',
    )
  } finally {
    release()
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
