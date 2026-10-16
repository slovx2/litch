import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

test('SESSION-002：原生会话生命周期、Git 元数据及删除在重启后保持一致', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-session-'))
  const model = new MockLLM()
  const url = await model.start()
  let client = await ProtocolClient.start(home, url)
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const threadId = thread.id
    await client.request('thread/name/set', { threadId, name: '生命周期测试' })
    assert.equal((await client.notification('thread/name/updated')).threadName, '生命周期测试')
    const gitInfo = { sha: 'a'.repeat(40), branch: 'main', originUrl: '/local/bare.git' }
    const metadata = await client.request('thread/metadata/update', { threadId, gitInfo })
    assert.deepEqual(metadata.thread.gitInfo, gitInfo, '元数据更新不能空成功')
    const partial = await client.request('thread/metadata/update', {
      threadId,
      gitInfo: { branch: null },
    })
    const expectedGit = { ...gitInfo, branch: null }
    assert.deepEqual(partial.thread.gitInfo, expectedGit, '清空指定字段不能影响省略的字段')
    for (const invalid of [{ branch: '' }, { sha: 123 }, [], 'main']) {
      assert.equal(
        (await client.raw('thread/metadata/update', { threadId, gitInfo: invalid }, -32602)).error
          ?.code,
        -32602,
      )
    }
    assert.deepEqual(
      (await client.request('thread/read', { threadId })).thread.gitInfo,
      expectedGit,
    )
    await client.request('thread/settings/update', {
      threadId,
      model: 'claude-sonnet-4-6',
      effort: 'low',
    })
    assert.equal(
      (await client.notification('thread/settings/updated')).threadSettings.effort,
      'low',
    )
    model.enqueue((request) => {
      assert.equal(request.model, 'claude-sonnet-4-6')
      return [{ type: 'text', text: 'SESSION_ORIGINAL_RESULT' }]
    })
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'SESSION_ORIGINAL_INPUT' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const { thread: fork } = await client.request('thread/fork', { threadId })
    assert.notEqual(fork.id, threadId)
    assert.equal(fork.forkedFromId, threadId)
    assert.deepEqual(fork.gitInfo, expectedGit)
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /SESSION_ORIGINAL_INPUT/)
      return [{ type: 'text', text: 'SESSION_FORK_RESULT' }]
    })
    const forkTurn = await client.request('turn/start', {
      threadId: fork.id,
      input: [{ type: 'text', text: 'SESSION_FORK_INPUT' }],
    })
    assert.equal((await client.completed(forkTurn.turn.id)).status, 'completed')
    assert.equal((await client.request('thread/read', { threadId })).thread.turns.length, 1)
    const calls = model.requests.length
    await client.request('thread/archive', { threadId })
    await client.notification('thread/archived', (p) => p.threadId === threadId)
    assert.equal(
      (await client.request('thread/list', { archived: false })).data.some(
        (t: any) => t.id === threadId,
      ),
      false,
    )
    assert.equal(
      (await client.request('thread/list', { archived: true })).data.some(
        (t: any) => t.id === threadId,
      ),
      true,
    )
    const restored = await client.request('thread/unarchive', { threadId })
    assert.equal(restored.thread.name, '生命周期测试')
    assert.deepEqual(restored.thread.gitInfo, expectedGit)
    await client.notification('thread/unarchived', (p) => p.threadId === threadId)
    assert.equal((await client.request('thread/unsubscribe', { threadId })).status, 'unsubscribed')
    await client.notification('thread/closed', (p) => p.threadId === threadId)
    assert.equal((await client.request('thread/loaded/list')).data.includes(threadId), false)
    await client.request('thread/resume', { threadId })
    assert.equal(model.requests.length, calls, '生命周期与历史读取不能调用模型')
    await client.close()
    client = await ProtocolClient.start(home, url)
    const resumed = await client.request('thread/resume', { threadId })
    assert.equal(resumed.thread.name, '生命周期测试')
    assert.deepEqual(resumed.thread.gitInfo, expectedGit)
    assert.equal(resumed.thread.turns.length, 1)
    assert.equal(resumed.reasoningEffort, 'low')
    await client.request('thread/metadata/update', { threadId, gitInfo: null })
    assert.equal((await client.request('thread/read', { threadId })).thread.gitInfo, null)
    await client.request('thread/delete', { threadId })
    assert.equal(
      (await client.request('thread/loaded/list')).data.includes(threadId),
      false,
      '已删除会话不能残留在已加载列表',
    )
    for (const method of [
      'thread/read',
      'thread/name/set',
      'thread/archive',
      'thread/unarchive',
      'thread/delete',
    ]) {
      assert.equal(
        (await client.raw(method, { threadId, name: '不存在' })).error?.code,
        -32602,
        method,
      )
    }
    await client.close()
    client = await ProtocolClient.start(home, url)
    assert.equal((await client.raw('thread/read', { threadId })).error?.code, -32602)
    assert.equal(
      (await client.request('thread/read', { threadId: fork.id })).thread.turns.length,
      2,
    )
    assert.equal(model.requests.length, calls)
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
