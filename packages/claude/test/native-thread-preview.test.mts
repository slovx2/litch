import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deferred } from './fixtures/deferred.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 第一个回合还在跑的时候，会话的信息在真实 CLI 上是什么样（进程内的那份在 thread-preview.test.mts）。
// 上游（rust-v0.162.0-alpha.20）：thread/started 时预览为空；第一句话发出去就有预览，
// 没有专门的通知，没订阅的客户端靠 thread/list、thread/read 拿；名字要客户端自己起、自己设。

const text = (value: string) => [{ type: 'text', text: value }]

test('NATIVE-PREVIEW-001：真实 CLI 第一个回合还在跑（模型还没回话），按标识读、列会话都已经带着第一句话', {
  timeout: 120_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-preview-'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    assert.equal(thread.preview, '')
    const started = await client.notification('thread/started', (p) => p.thread.id === thread.id)
    assert.equal(started.thread.preview, '', '新建时还没说过话')
    assert.ok(
      !(await client.request('thread/list', {})).data.some((t: any) => t.id === thread.id),
      '还没说过话的不列',
    )

    const asked = deferred()
    const release = deferred()
    model.enqueue(async () => {
      asked.resolve()
      await release.promise
      return [{ type: 'text', text: '好的' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: text('出个计划\n分三步'),
    })
    // 模型已经收到请求、还没回话：回合确实在跑
    await asked.promise
    const read = (await client.request('thread/read', { threadId: thread.id })).thread
    assert.equal(read.preview, '出个计划\n分三步')
    assert.equal(read.status.type, 'active')
    assert.equal(read.name, null, '入口不自己起名')
    const listed = (await client.request('thread/list', {})).data.find(
      (t: any) => t.id === thread.id,
    )
    assert.equal(listed?.preview, '出个计划\n分三步', '列会话也已经有')

    release.resolve()
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(
      (await client.request('thread/read', { threadId: thread.id })).thread.preview,
      '出个计划\n分三步',
    )
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
