import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 会话报的模型在 model/list 里总找得到对应的一行（真实 CLI 的原生目录）。
// CHA_CLAUDE_DEFAULT_MODEL 可以写 CLI 认的任何写法（别名或完整型号），目录里没有的补一行并标成默认；
// thread/start 显式带了目录之外的模型同样补一行；只是大小写不同的按目录里的写法记。

test('MODEL-001：默认模型和会话指定的模型不在原生目录里时，清单里补上对应的一行', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-model-list-'))
  const model = new MockLLM()
  // 夹具的默认模型是 claude-sonnet-4-6：CLI 认这个完整型号，但它不在原生目录里
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const list = async () => (await client.request('model/list', {})).data
    const before = await list()
    const configured = before.find((entry: any) => entry.id === 'claude-sonnet-4-6')
    assert.ok(configured, JSON.stringify(before.map((entry: any) => entry.id)))
    assert.equal(configured.isDefault, true)
    assert.equal(configured.displayName, 'Sonnet 4.6')
    assert.ok(configured.supportedReasoningEfforts.length > 0)
    assert.equal(before.filter((entry: any) => entry.isDefault).length, 1)
    // 原生目录的行都还在
    assert.ok(before.some((entry: any) => entry.id === 'default'))

    const plain = await client.request('thread/start', { cwd: home })
    assert.equal(plain.model, 'claude-sonnet-4-6')

    const pinned = await client.request('thread/start', { cwd: home, model: 'claude-opus-4-6' })
    assert.equal(pinned.model, 'claude-opus-4-6')
    const after = await list()
    const extra = after.find((entry: any) => entry.id === 'claude-opus-4-6')
    assert.ok(extra, '会话指定的模型也要在清单里')
    assert.equal(extra.isDefault, false)
    assert.equal(extra.displayName, 'Opus 4.6')

    const cased = await client.request('thread/start', { cwd: home, model: 'SONNET' })
    assert.equal(cased.model, 'sonnet')
    const ids = (await list()).map((entry: any) => entry.id)
    for (const reported of [plain.model, pinned.model, cased.model])
      assert.ok(ids.includes(reported), `${reported} 不在 ${ids.join(',')}`)
    assert.equal(new Set(ids.map((id: string) => id.toLowerCase())).size, ids.length)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
