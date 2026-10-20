import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// CHA_CLAUDE_EXTENDED_CACHE_TTL：默认入口往 ANTHROPIC_BETAS 补 1 小时缓存的 beta；设成 0 时 CLI 发的 beta 头和直接跑 CLI 时一样。
// 请求体里的 cache_control.ttl 不是入口写的：API key 时 CLI 不写（带不带这个 beta 都一样），
// 订阅登录时 CLI 自己写 ttl: "1h" 并自己带上这个 beta，所以关掉开关不会出现“写了 ttl 却缺 beta”。

const BETA = 'extended-cache-ttl-2025-04-11'

const cases = [
  { label: 'API key、默认', auth: 'api-key', env: {}, beta: true, ttl: false },
  {
    label: 'API key、关掉',
    auth: 'api-key',
    env: { CHA_CLAUDE_EXTENDED_CACHE_TTL: '0' },
    beta: false,
    ttl: false,
  },
  {
    label: 'API key、关掉、用户自己给了 ANTHROPIC_BETAS',
    auth: 'api-key',
    env: { CHA_CLAUDE_EXTENDED_CACHE_TTL: '0', ANTHROPIC_BETAS: 'user-beta-2026-01-01' },
    beta: false,
    ttl: false,
    user: true,
  },
  { label: '订阅登录、默认', auth: 'oauth', env: {}, beta: true, ttl: true },
  {
    label: '订阅登录、关掉（CLI 自己带）',
    auth: 'oauth',
    env: { CHA_CLAUDE_EXTENDED_CACHE_TTL: '0' },
    beta: true,
    ttl: true,
  },
] as const

for (const item of cases)
  test(`EXTENDED-CACHE-TTL-001：${item.label}`, { timeout: 100_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-cache-ttl-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start(), false, item.auth, item.env)
    try {
      let betas: string[] = []
      let body = ''
      model.enqueue((request, headers) => {
        betas = String(headers['anthropic-beta'] ?? '').split(',')
        body = JSON.stringify(request)
        return [{ type: 'text', text: 'DONE' }]
      })
      const { thread } = await client.request('thread/start', { cwd: home })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '你好' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      assert.equal(betas.includes(BETA), item.beta, betas.join(','))
      assert.equal(body.includes('"ttl":"1h"'), item.ttl)
      assert.ok(body.includes('"cache_control":{"type":"ephemeral"'), '提示缓存照常')
      if ('user' in item) assert.ok(betas.includes('user-beta-2026-01-01'), '用户给的 beta 照旧')
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
