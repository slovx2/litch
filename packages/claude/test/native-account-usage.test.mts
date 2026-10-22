import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 只答 initialize 和 get_usage 的假 CLI：钥匙串登录的订阅账号的额度只能靠 get_usage 读，测试里没有真账号
const fakeCli = fileURLToPath(
  new URL('../../../test/fixtures/fake-claude-usage.mjs', import.meta.url),
)

const usage = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 45, resets_at: '2026-10-22T12:30:00.000Z' },
    seven_day: { utilization: 18.4, resets_at: '2026-10-27T02:00:00.000Z' },
    seven_day_oauth_apps: { utilization: 99, resets_at: null },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: '2026-10-27T02:00:00.000Z' },
    model_scoped: [{ display_name: 'Fable', utilization: 12.5, resets_at: null }],
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  },
}

async function calls(home: string): Promise<unknown[]> {
  try {
    return (await readFile(join(home, 'claude', 'fake-usage-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('ACCOUNT-003：账号额度用 CLI 的 get_usage 读齐，按模型分的周额度另起一份，一分钟内不重复问', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-usage-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client: ProtocolClient | null = null
  try {
    // 夹具在适配器起来之前就要有配置目录里的回答
    client = await ProtocolClient.start(home, url, false, 'api-key', { CHA_CLAUDE_CLI: fakeCli })
    await writeFile(join(home, 'claude', 'fake-usage.json'), JSON.stringify(usage))
    const read = await client.request('account/rateLimits/read', null)
    assert.deepEqual(read.rateLimits.primary, {
      usedPercent: 45,
      windowDurationMins: 300,
      resetsAt: Date.parse('2026-10-22T12:30:00.000Z') / 1000,
    })
    assert.equal(read.rateLimits.secondary.usedPercent, 18)
    assert.equal(read.rateLimits.secondary.windowDurationMins, 10080)
    const sonnet = read.rateLimitsByLimitId['claude-code:seven_day_sonnet']
    assert.equal(sonnet.limitName, 'Sonnet')
    assert.equal(sonnet.primary.usedPercent, 3)
    const fable = read.rateLimitsByLimitId['claude-code:model:Fable']
    assert.equal(fable.limitName, 'Fable')
    assert.deepEqual(fable.primary, { usedPercent: 13, windowDurationMins: 10080, resetsAt: null })
    assert.deepEqual(
      Object.keys(read.rateLimitsByLimitId).sort(),
      ['claude-code', 'claude-code:model:Fable', 'claude-code:seven_day_sonnet'],
      '不是用量窗口的（第三方应用、额外用量）和没有数据的不报',
    )
    assert.deepEqual(await calls(home), [{ skip_behaviors: true }], '只要额度，不扫本机会话记录')
    const updates = client.trace.filter((entry) => entry.method === 'account/rateLimits/updated')
    assert.deepEqual(updates.map((entry) => entry.params.rateLimits.limitId).sort(), [
      'claude-code',
      'claude-code:model:Fable',
      'claude-code:seven_day_sonnet',
    ])
    // 一分钟内再读不再起 CLI，给的还是上次的
    await writeFile(
      join(home, 'claude', 'fake-usage.json'),
      JSON.stringify({ ...usage, rate_limits_available: false, rate_limits: null }),
    )
    const again = await client.request('account/rateLimits/read', null)
    assert.equal(again.rateLimits.primary.usedPercent, 45)
    assert.equal((await calls(home)).length, 1)
    await client.close()

    // 新的进程：账号没有额度（API key 之类）时什么都不报，也不发通知
    client = await ProtocolClient.start(home, url, false, 'api-key', { CHA_CLAUDE_CLI: fakeCli })
    const none = await client.request('account/rateLimits/read', null)
    assert.equal(none.rateLimits.primary, null)
    assert.equal(none.rateLimits.secondary, null)
    assert.deepEqual(Object.keys(none.rateLimitsByLimitId), ['claude-code'])
    assert.equal(client.trace.filter((e) => e.method === 'account/rateLimits/updated').length, 0)
    assert.equal((await calls(home)).length, 2)
  } finally {
    await client?.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
