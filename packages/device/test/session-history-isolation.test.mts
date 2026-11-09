import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineLink } from '../src/engine-link.mjs'
import { SessionRecoveryBudget } from '../src/session-history.mjs'
import { resultOf } from './fake-engine.mjs'
import { litch, parent, SESSIONS, treeRig } from './tree-kit.mjs'

// 120MiB的逻辑历史复用1MiB字符串；假连接直接返回对象，不序列化巨帧、不写磁盘。
test('经理读超大子线用分页；坏页断链不影响新线读取、订阅和发送', async () => {
  const env = treeRig()
  const tree = env.device.sessionTree
  const original = tree.host.openEngineLink
  const text = 'x'.repeat(1024 * 1024)
  const history = Array.from({ length: 120 }, (_, i) => ({
    id: `t${i}`,
    status: 'completed',
    items: [{ type: 'agentMessage', id: `a${i}`, text }],
  }))
  const connections: EngineLink[] = []
  const calls: { connection: EngineLink; method: string; params: any }[] = []
  let broken = false
  let releaseBad: (() => void) | undefined
  tree.host.openEngineLink = async (harness) => {
    if (harness !== 'codex') return original(harness)
    let closed = false
    const link: EngineLink = {
      harness,
      native: true,
      runtime: null,
      get closed() {
        return closed
      },
      async request(method, params: any) {
        assert.equal(closed, false)
        calls.push({ connection: link, method, params })
        if (method === 'thread/read') {
          assert.equal(params.includeTurns, false)
          return { thread: { id: params.threadId, status: { type: 'idle' }, turns: [] } }
        }
        if (method === 'thread/resume') {
          assert.equal(params.excludeTurns, true)
          return { thread: { id: params.threadId, turns: [] } }
        }
        if (method === 'turn/start') return { turn: { id: 'new-turn', status: 'inProgress' } }
        assert.equal(method, 'thread/turns/list')
        assert.ok(params.limit <= 10)
        if (broken && params.threadId === 'large') {
          await new Promise<void>((resolve) => {
            releaseBad = resolve
          })
          closed = true
          throw new Error('响应超过 WebSocket 100 MiB 上限')
        }
        const turns = params.threadId === 'large' ? history : history.slice(0, 1)
        const offset = Number(params.cursor ?? 0),
          end = offset + params.limit
        return {
          data: [...turns].reverse().slice(offset, end),
          nextCursor: end < turns.length ? String(end) : null,
        }
      },
      onNotification: () => () => {},
      onServerRequest: () => () => {},
      onClose: () => () => {},
      claimRequests() {},
      claimed: () => false,
      answer: () => false,
      close() {
        closed = true
      },
    }
    connections.push(link)
    return link
  }
  try {
    const client = await litch(env)
    const { threadId } = await parent(client)
    for (const id of ['large', 'new']) tree.host.index.see({ id, updatedAt: 1 }, 'codex')
    const read = resultOf(
      (await env.pi.callTool(threadId, SESSIONS, 'read', { thread_id: 'large', turns: 1 }))?.answer,
    )
    assert.equal(read.turns.length, 1)
    assert.equal(calls.filter((c) => c.method === 'thread/turns/list').length, 12)
    assert.equal(connections[1]?.closed, true, '读完释放历史连接')
    broken = true
    const bad = assert.rejects(tree.read('large', true), /100 MiB/)
    while (!releaseBad) await new Promise((resolve) => setImmediate(resolve))
    const fresh = await tree.read('new', true, 1)
    assert.equal((fresh.thread.turns as unknown[]).length, 1)
    await tree.watch('codex', 'new')
    releaseBad()
    await bad
    const shared = await tree.link('codex')
    assert.equal(shared.closed, false, '坏会话不能关掉共享编排连接')
    const waited = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'wait', {
          thread_ids: ['new'],
          timeout_seconds: 1,
        })
      )?.answer,
    )
    assert.equal(waited.sessions[0]?.thread_id, 'new')
    const sent = resultOf(
      (
        await env.pi.callTool(threadId, SESSIONS, 'send', {
          thread_id: 'new',
          message: '继续这个新会话',
        })
      )?.answer,
    )
    assert.equal(sent.thread_id, 'new')
    assert.equal(calls.at(-1)?.method, 'turn/start')
  } finally {
    releaseBad?.()
    await env.close()
  }
})

test('重复触发恢复不能重置坏会话预算，其他会话仍可恢复', async () => {
  const env = treeRig()
  const tree = env.device.sessionTree
  const attempts = new Map<string, number>()
  const internal = tree as any
  internal.recoveryBudget = new SessionRecoveryBudget([0, 0, 0])
  for (const threadId of ['bad', 'good'])
    tree.store.addLineage({
      threadId,
      parentThreadId: 'parent',
      harness: 'codex',
      kind: 'fresh',
      origin: 'model',
      title: threadId,
      prompt: '',
      wakeParent: false,
      createdAt: 1,
    })
  tree.read = async (id) => {
    attempts.set(id, (attempts.get(id) ?? 0) + 1)
    if (id === 'bad') throw new Error('读取失败')
    return { harness: 'codex', thread: { id, status: { type: 'idle' }, turns: [] } }
  }
  try {
    for (let i = 0; i < 8; i++) await internal.recover('codex')
    assert.equal(attempts.get('bad'), 3)
    assert.ok((attempts.get('good') ?? 0) >= 8)
  } finally {
    await env.close()
  }
})
