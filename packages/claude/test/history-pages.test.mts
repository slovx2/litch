import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MockRuntime } from '../src/mock-runtime.mjs'
import { CodexClaudeAppServer } from '../src/server.mjs'
import { SessionStore } from '../src/store.mjs'
import type { RpcPeer, TurnRecord, WireMessage } from '../src/types.mjs'

test('大历史分页与头部游标只解析所需回合；旧客户端仍取全量', async () => {
  const home = await mkdtemp(join(tmpdir(), 'history-page-'))
  const store = new SessionStore(join(home, 'state.sqlite'))
  const server = new CodexClaudeAppServer(store, new MockRuntime())
  let seq = 0
  const messages: WireMessage[] = []
  const peer: RpcPeer = {
    id: 'page-test',
    close() {},
    send: (message) => {
      messages.push(message)
    },
  }
  const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++seq
    await server.handle(peer, { id, method, params })
    const reply = messages.find((message) => 'id' in message && message.id === id) as any
    assert.equal(reply.error, undefined, JSON.stringify(reply.error))
    return reply.result
  }
  try {
    const { thread } = await call('thread/start', { cwd: home })
    for (let i = 0; i < 400; i++)
      store.upsertTurn({
        id: `t${i}`,
        threadId: thread.id,
        startedAt: i,
        completedAt: i + 1,
        durationMs: 1,
        status: 'completed',
        diff: '',
        error: null,
        items: [
          {
            type: 'agentMessage',
            id: `a${i}`,
            text: 'x'.repeat(100_000),
            phase: 'final',
            memoryCitation: null,
          },
        ],
      } satisfies TurnRecord)
    // 末尾空回合：最新条目属于上一个回合，两个头部游标不能混为一谈。
    store.upsertTurn({
      id: 'empty',
      threadId: thread.id,
      startedAt: 500,
      completedAt: 501,
      durationMs: 1,
      status: 'completed',
      diff: '',
      error: null,
      items: [],
    })
    const parse = JSON.parse
    let parsed = 0
    JSON.parse = (
      text: string,
      ...rest: Parameters<typeof JSON.parse> extends [string, ...infer R] ? R : never
    ) => {
      parsed += text.length
      return parse(text, ...rest)
    }
    try {
      const resumed = await call('thread/resume', {
        threadId: thread.id,
        excludeTurns: true,
        initialTurnsPage: { limit: 10, sortDirection: 'desc', itemsView: 'full' },
      })
      assert.deepEqual(resumed.thread.turns, [])
      assert.equal(resumed.initialTurnsPage.data.length, 10)
      assert.ok(parsed < 2_000_000, `首屏解析了 ${parsed} 字符（不应读取约40MB全部历史）`)
      const turnHead = JSON.parse(Buffer.from(resumed.turnsBackwardsCursor, 'base64url').toString())
      const itemHead = JSON.parse(Buffer.from(resumed.itemsBackwardsCursor, 'base64url').toString())
      assert.equal(turnHead.id, 'empty')
      assert.equal(itemHead.id, 't399:a399')
      parsed = 0
      const older = await call('thread/turns/list', {
        threadId: thread.id,
        cursor: resumed.initialTurnsPage.nextCursor,
        limit: 10,
        itemsView: 'full',
        sortDirection: 'desc',
      })
      assert.equal(older.data[0].id, 't390')
      assert.ok(parsed < 1_200_000, `下一页解析了 ${parsed} 字符`)
      parsed = 0
      const full = await call('thread/resume', { threadId: thread.id })
      assert.equal(full.thread.turns.length, 401)
      assert.ok(parsed >= 40_000_000 && parsed < 42_000_000, `全量不能再为游标二次全读：${parsed}`)
    } finally {
      JSON.parse = parse
    }
  } finally {
    await server.stop()
    await rm(home, { recursive: true, force: true })
  }
})
