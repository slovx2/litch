import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// Claude 会话的自动命名：CLI 自己用小模型起标题（会话记录里的 ai-title），入口读出来发 thread/name/updated。
// 宿主环境让 CLI 不自己起名时（CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC，协议用例默认就设着），
// 入口请还开着的 CLI 现起一个。两条路起标题的请求都由 MockLLM 按请求内容认出来、回 sessionTitle。

async function firstTurn(
  client: ProtocolClient,
  llm: MockLLM,
  home: string,
  rename: string | null = null,
): Promise<string> {
  llm.enqueue(() => [{ type: 'text', text: 'TITLE_REPLY' }])
  const { thread } = await client.request('thread/start', { cwd: home })
  if (rename) await client.request('thread/name/set', { threadId: thread.id, name: rename })
  const { turn } = await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: '帮我看看登录按钮为什么点了没反应' }],
  })
  assert.equal((await client.completed(turn.id)).status, 'completed')
  llm.assertConsumed()
  return thread.id
}

for (const [label, env] of [
  ['CLI 自己起的标题', { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' }],
  ['CLI 不自己起名时请它现起', {}],
] as const)
  test(`TITLE-001：${label}，第一回合后成了会话名`, { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-title-'))
    const llm = new MockLLM()
    llm.sessionTitle = '排查登录按钮'
    const url = await llm.start()
    const client = await ProtocolClient.start(home, url, false, 'api-key', env)
    try {
      const threadId = await firstTurn(client, llm, home)
      const named = await client.notification(
        'thread/name/updated',
        (params) => params.threadId === threadId,
      )
      assert.equal(named.threadName, '排查登录按钮')
      assert.ok(llm.titleRequests.length >= 1)
      const { thread } = await client.request('thread/read', { threadId })
      assert.equal(thread.name, '排查登录按钮')
    } finally {
      await client.close()
      await llm.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

test('TITLE-002：用户改过名的不被自动起的标题覆盖', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-title-kept-'))
  const llm = new MockLLM()
  llm.sessionTitle = '排查登录按钮'
  const url = await llm.start()
  const client = await ProtocolClient.start(home, url)
  try {
    const threadId = await firstTurn(client, llm, home, '我自己起的名')
    // 第二个回合结束时还会再看一次，也不能覆盖
    llm.enqueue(() => [{ type: 'text', text: 'TITLE_REPLY_2' }])
    const { turn } = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '接着看' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const renames = client.trace.filter(
      (message) => message.method === 'thread/name/updated' && message.params.threadId === threadId,
    )
    assert.deepEqual(
      renames.map((message) => message.params.threadName),
      ['我自己起的名'],
    )
    const { thread } = await client.request('thread/read', { threadId })
    assert.equal(thread.name, '我自己起的名')
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('TITLE-003：起不出标题时会话保持没有名字', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-title-none-'))
  const llm = new MockLLM()
  const url = await llm.start()
  const client = await ProtocolClient.start(home, url)
  try {
    const threadId = await firstTurn(client, llm, home)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      client.trace.some((message) => message.method === 'thread/name/updated'),
      false,
    )
    const { thread } = await client.request('thread/read', { threadId })
    assert.equal(thread.name, null)
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// CHA_CLAUDE_SESSION_TITLE=off：CLI 自己不起（给它设 CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1），入口也不请它起、
// 不读标题。两种宿主环境（CLI 本来会自己起的、本来不起要入口请的）下，几个回合里都不能有起标题的请求
for (const [label, env] of [
  ['CLI 本来会自己起名', { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '' }],
  ['CLI 本来要入口请它起', {}],
] as const)
  test(`TITLE-004：关掉自动起名（${label}），整个会话不发起标题的请求，名字只来自 thread/name/set`, {
    timeout: 90_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-title-off-'))
    const llm = new MockLLM()
    llm.sessionTitle = '排查登录按钮'
    const url = await llm.start()
    const client = await ProtocolClient.start(home, url, false, 'api-key', {
      ...env,
      CHA_CLAUDE_SESSION_TITLE: 'off',
    })
    try {
      const threadId = await firstTurn(client, llm, home)
      llm.enqueue(() => [{ type: 'text', text: 'TITLE_REPLY_2' }])
      const { turn } = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: '接着看' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      // 标题是异步起的：多等一会儿，晚到的请求也要抓到
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      assert.equal(llm.titleRequests.length, 0, '不能有起标题的请求')
      // 每个模型请求都是计划里的那两个回合（认不出的起标题请求会落进 requests、变成未计划的请求）
      assert.equal(llm.requests.length, 2)
      assert.deepEqual(llm.unexpected, [])
      llm.assertConsumed()
      assert.equal(
        client.trace.some((message) => message.method === 'thread/name/updated'),
        false,
      )
      assert.equal((await client.request('thread/read', { threadId })).thread.name, null)
      // 客户端改名照常生效、照常通知
      await client.request('thread/name/set', { threadId, name: '我自己起的名' })
      const named = await client.notification(
        'thread/name/updated',
        (params) => params.threadId === threadId,
      )
      assert.equal(named.threadName, '我自己起的名')
    } finally {
      await client.close()
      await llm.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
