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

test('ACP 账号控制要求最终客户端声明，设备上游握手也声明扩展', async () => {
  const agy = new FakeUpstream('agy')
  agy.handlers['litch/acp/auth/read'] = () => ({
    methods: [],
    logout: true,
    instruction: 'agy acp --login',
    status: 'signedOut',
  })
  agy.handlers['litch/acp/auth/authenticate'] = () => ({})
  agy.handlers['litch/acp/auth/logout'] = () => ({})
  const env = rig({ agy })
  try {
    const plain = env.connect()
    await plain.initialize()
    const failure = await plain.fails('litch/acp/auth/read', { harness: 'agy' })
    assert.match(failure.message, /acpControls/)
    const client = env.connect()
    await client.initialize(['harness', 'acpControls'])
    assert.equal((await client.call('litch/acp/auth/read', { harness: 'agy' })).status, 'signedOut')
    await client.call('litch/acp/auth/authenticate', { harness: 'agy', methodId: 'oauth-personal' })
    await client.call('litch/acp/auth/logout', { harness: 'agy' })
    assert.ok(
      agy.seen
        .filter((m) => m.method === 'initialize')
        .some((m) => m.params.capabilities.litchExtensions.includes('acpControls')),
    )
    assert.equal(agy.seen.filter((m) => m.method === 'litch/acp/auth/authenticate').length, 1)
  } finally {
    await env.close()
  }
})
