import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// CHA_CLAUDE_PROMPT_CACHE_TTL：默认入口什么都不设，CLI 发的请求和直接跑 CLI 时一样；1h 时设 CLI 自己的
// ENABLE_PROMPT_CACHING_1H、CLAUDE_CODE_PROMPT_CACHE_TTL、CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL，
// 请求体里的 cache_control.ttl 和 anthropic-beta 由 CLI 自己决定。真实 CLI 加回环上的假模型，抓主对话的请求。

const BETA = 'extended-cache-ttl-2025-04-11'

/** 请求体里各个 cache_control 的 ttl（没写 ttl 的记成 none） */
function ttls(body: unknown): string[] {
  const found: string[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) for (const item of value) walk(item)
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const control = record.cache_control as Record<string, unknown> | undefined
      if (control && typeof control === 'object') found.push(String(control.ttl ?? 'none'))
      for (const [key, item] of Object.entries(record)) if (key !== 'cache_control') walk(item)
    }
  }
  walk(body)
  return found
}

const cases = [
  { label: 'API key、默认', auth: 'api-key', env: {}, ttl: 'none', beta: false },
  {
    label: 'API key、1h',
    auth: 'api-key',
    env: { CHA_CLAUDE_PROMPT_CACHE_TTL: '1h' },
    ttl: '1h',
    beta: true,
  },
  { label: '订阅登录、默认', auth: 'oauth', env: {}, ttl: '1h', beta: true },
  {
    label: '订阅登录、1h',
    auth: 'oauth',
    env: { CHA_CLAUDE_PROMPT_CACHE_TTL: '1h' },
    ttl: '1h',
    beta: true,
  },
] as const

for (const item of cases)
  test(`PROMPT-CACHE-TTL-001：${item.label}`, { timeout: 100_000 }, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'native-cache-ttl-'))
    const model = new MockLLM()
    const client = await ProtocolClient.start(home, await model.start(), false, item.auth, item.env)
    try {
      let betas: string[] = []
      let seen: string[] = []
      model.enqueue((request, headers) => {
        betas = String(headers['anthropic-beta'] ?? '')
          .split(',')
          .filter(Boolean)
        seen = ttls(request)
        return [{ type: 'text', text: 'DONE' }]
      })
      const { thread } = await client.request('thread/start', { cwd: home })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: '你好' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
      model.assertConsumed()
      t.diagnostic(`cache_control.ttl=${seen.join(',')} anthropic-beta=${betas.join(',')}`)
      assert.ok(seen.length > 0, '提示缓存照常')
      assert.deepEqual([...new Set(seen)], [item.ttl], seen.join(','))
      assert.equal(betas.includes(BETA), item.beta, betas.join(','))
    } finally {
      await client.close()
      await model.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
