import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

async function fixture(run: (client: ProtocolClient, home: string, url: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'native-experimental-features-'))
  const model = new MockLLM()
  const url = await model.start()
  const client = await ProtocolClient.start(home, url)
  try {
    await run(client, home, url)
    assert.equal(model.requests.length, 0, '目录与开关校验不能调用模型')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('FEATURE-001：真实空实验目录严格校验 uint32、游标和已加载会话', {
  timeout: 60_000,
}, async () => {
  await fixture(async (client, home) => {
    const empty = { data: [], nextCursor: null }
    for (const params of [
      {},
      { limit: null, cursor: null, threadId: null },
      ...[0, 1, 1001, 4294967295].map((limit) => ({ limit })),
    ])
      assert.deepEqual(await client.request('experimentalFeature/list', params), empty)
    for (const params of [
      null,
      [],
      true,
      { limit: -1 },
      { limit: 1.5 },
      { limit: '2' },
      { limit: true },
      { limit: 4294967296 },
      { cursor: '' },
      { cursor: 'invalid' },
      { cursor: 1 },
      { threadId: '' },
      { threadId: false },
      { threadId: 'unknown-thread' },
    ])
      await client.raw('experimentalFeature/list', params, -32602)
    const models = await client.request('model/list', { limit: 1 })
    assert.ok(models.nextCursor)
    await client.raw('experimentalFeature/list', { cursor: models.nextCursor }, -32602)
    const { thread } = await client.request('thread/start', { cwd: home })
    assert.ok((await client.request('thread/loaded/list')).data.includes(thread.id))
    assert.deepEqual(
      await client.request('experimentalFeature/list', { threadId: thread.id }),
      empty,
    )
    await client.request('thread/unsubscribe', { threadId: thread.id })
    assert.ok(!(await client.request('thread/loaded/list')).data.includes(thread.id))
    await client.raw('experimentalFeature/list', { threadId: thread.id }, -32602)
    await client.request('thread/resume', { threadId: thread.id })
    assert.deepEqual(
      await client.request('experimentalFeature/list', { threadId: thread.id }),
      empty,
    )
    await client.request('thread/archive', { threadId: thread.id })
    // 归档当前不卸载，目录身份与真实 loaded 列表保持一致。
    assert.ok((await client.request('thread/loaded/list')).data.includes(thread.id))
    assert.deepEqual(
      await client.request('experimentalFeature/list', { threadId: thread.id }),
      empty,
    )
    await client.request('thread/delete', { threadId: thread.id })
    assert.ok(!(await client.request('thread/loaded/list')).data.includes(thread.id))
    await client.raw('experimentalFeature/list', { threadId: thread.id }, -32602)
  })
})

test('FEATURE-001：实验开关仅空 map 无操作成功，拒绝无效与未实现开关且配置会话不变', {
  timeout: 60_000,
}, async () => {
  await fixture(async (client, home, url) => {
    const configPath = join(home, 'adapter', 'config.json')
    await assert.rejects(access(configPath))
    assert.deepEqual(
      await client.request('experimentalFeature/enablement/set', { enablement: {} }),
      { enablement: {} },
    )
    await assert.rejects(access(configPath), '无操作不能创建配置文件')
    await client.request('config/value/write', {
      keyPath: 'sandbox_mode',
      value: 'read-only',
      mergeStrategy: 'replace',
    })
    const config = await client.request('config/read', {})
    const bytes = await readFile(configPath)
    const { thread } = await client.request('thread/start', { cwd: home })
    const before = await client.request('thread/read', { threadId: thread.id, includeTurns: true })
    const notificationStart = client.trace.length
    for (const params of [
      null,
      [],
      {},
      { enablement: null },
      { enablement: [] },
      { enablement: true },
      { enablement: 'bad' },
      ...['invalid', 1, null, {}, []].map((value) => ({ enablement: { unknown: value } })),
      { enablement: { valid: true, invalid: 'no' } },
    ])
      await client.raw('experimentalFeature/enablement/set', params, -32602)
    for (const enablement of [
      { unknown: true },
      { unknown: false },
      { memories: true },
      { demo: true, memories: false },
    ])
      await client.raw('experimentalFeature/enablement/set', { enablement }, -32004)
    assert.deepEqual(
      await client.request('experimentalFeature/enablement/set', { enablement: {} }),
      { enablement: {} },
    )
    assert.deepEqual(await client.request('experimentalFeature/list'), {
      data: [],
      nextCursor: null,
    })
    assert.deepEqual(await client.request('config/read', {}), config)
    assert.deepEqual(await readFile(configPath), bytes)
    assert.deepEqual(
      await client.request('thread/read', { threadId: thread.id, includeTurns: true }),
      before,
    )
    assert.equal(
      client.trace
        .slice(notificationStart)
        .some((message) => message.method === 'thread/settings/updated'),
      false,
    )
    await client.close()
    const restarted = await ProtocolClient.start(home, url)
    try {
      assert.deepEqual(await restarted.request('experimentalFeature/list'), {
        data: [],
        nextCursor: null,
      })
      assert.deepEqual(await restarted.request('config/read', {}), config)
      assert.deepEqual(await readFile(configPath), bytes)
    } finally {
      await restarted.close()
    }
  })
})
