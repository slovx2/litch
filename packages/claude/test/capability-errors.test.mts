import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('未知插件与市场方法返回 -32601，不冒充已知的不适用能力', async () => {
  const home = await mkdtemp(join(tmpdir(), 'unknown-capability-'))
  const client = await ProtocolClient.start(home, 'http://127.0.0.1:1', true)
  try {
    for (const method of ['plugin/unknown', 'marketplace/unknown', 'thread/items/unknown']) {
      const response = await client.raw(method)
      assert.equal(response.error.code, -32601, method)
      assert.equal(response.result, undefined)
    }
    assert.deepEqual(await client.request('account/read', {}), {
      account: null,
      requiresOpenaiAuth: false,
    })
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
