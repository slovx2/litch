import assert from 'node:assert/strict'
import test from 'node:test'
import { FakeUpstream } from './fake-upstream.mjs'
import { rig } from './helpers.mjs'

test('Antigravity 汇总保留后端命名空间，显式 agy 路由原样交给引擎', async () => {
  const agy = new FakeUpstream('agy')
  const rows = [
    { id: 'agy:sdk:same', updatedAt: 1, cwd: '/work', preview: 'sdk' },
    { id: 'agy:acp:same', updatedAt: 2, cwd: '/work', preview: 'acp' },
  ]
  agy.handlers['thread/list'] = () => ({ data: rows, nextCursor: null })
  agy.handlers['thread/read'] = (params) => ({
    thread: rows.find((thread) => thread.id === params.threadId),
  })
  const env = rig({ agy })
  try {
    const client = env.connect()
    await client.initialize()
    const result = await client.call('thread/list', { harness: 'agy' })
    assert.deepEqual(
      new Set(result.data.map((thread: any) => thread.id)),
      new Set(rows.map((thread) => thread.id)),
    )
    for (const row of rows) {
      const read = await client.call('thread/read', { harness: 'agy', threadId: row.id })
      assert.equal(read.thread.id, row.id)
      assert.equal(read.thread.harness, 'agy')
    }
  } finally {
    await env.close()
  }
})
