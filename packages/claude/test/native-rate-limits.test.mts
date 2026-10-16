import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

function rateHeaders(
  status: string,
  utilization: number,
  type = 'five_hour',
): Record<string, string> {
  const window = type === 'five_hour' ? '5h' : '7d'
  return {
    'anthropic-ratelimit-unified-status': status,
    'anthropic-ratelimit-unified-reset': '1800000000',
    [`anthropic-ratelimit-unified-${window}-reset`]: '1800000000',
    [`anthropic-ratelimit-unified-${window}-utilization`]: String(utilization),
    ...(status === 'allowed_warning'
      ? { [`anthropic-ratelimit-unified-${window}-surpassed-threshold`]: '0.9' }
      : {}),
    'anthropic-ratelimit-unified-representative-claim': type,
  }
}

async function modelTurn(client: ProtocolClient, threadId: string): Promise<string> {
  const { turn } = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: '报告 ACCOUNT_002 的模型结果' }],
  })
  return (await client.completed(turn.id)).status
}

function notifications(client: ProtocolClient): unknown[] {
  return client.trace.filter((entry) => entry.method === 'account/rateLimits/updated')
}

test('ACCOUNT-002：真实 SDK 限额响应头更新账户快照，不用 token usage 推算配额', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-rate-limits-'))
  const llm = new MockLLM()
  const url = await llm.start()
  let client = await ProtocolClient.start(home, url, false, 'oauth')
  try {
    assert.equal((await client.request('account/rateLimits/read', null)).rateLimits.primary, null)
    const { thread } = await client.request('thread/start', { cwd: home })
    llm.enqueue(() => ({
      content: [{ type: 'text', text: 'ACCOUNT_002_ALLOWED' }],
      headers: rateHeaders('allowed', 0.2),
    }))
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '报告 ACCOUNT_002_ALLOWED' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    const response = await client.request('account/rateLimits/read', null)
    assert.equal(response.rateLimits.primary.usedPercent, 20)
    assert.equal(response.rateLimits.primary.resetsAt, 1800000000)
    assert.equal(response.rateLimits.primary.windowDurationMins, 300)
    assert.equal(response.rateLimits.credits, null)
    assert.equal(response.rateLimits.planType, null)
    assert.equal(notifications(client).length, 1)
    assert.equal(client.trace.filter((entry) => entry.method === 'warning').length, 0)
    // 同一账户的另一个会话共享快照；相同响应不能制造重复配额通知。
    const { thread: other } = await client.request('thread/start', { cwd: home })
    for (const [utilization, status, type] of [
      [0.2, 'allowed', 'five_hour'],
      [0.95, 'allowed_warning', 'five_hour'],
      [0.325, 'allowed', 'seven_day'],
    ] as const) {
      llm.enqueue(() => ({
        content: [{ type: 'text', text: 'ACCOUNT_002_UPDATE' }],
        headers: rateHeaders(status, utilization, type),
      }))
      assert.equal(await modelTurn(client, other.id), 'completed')
    }
    const updated = (await client.request('account/rateLimits/read', null)).rateLimits
    assert.equal(updated.primary.usedPercent, 95)
    assert.equal(updated.secondary.usedPercent, 33, '固定schema为整数，比例必须四舍五入')
    assert.equal(updated.secondary.windowDurationMins, 10080)
    assert.equal(notifications(client).length, 3, '重复20%不通知，两个窗口分别更新')
    // 真正的 429 必须让回合失败；后续允许请求恢复且使用可超过100的实测比例。
    llm.enqueue(() => ({
      status: 429,
      message: '限额拒绝',
      headers: rateHeaders('rejected', 1.03),
    }))
    assert.equal(await modelTurn(client, thread.id), 'failed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary.usedPercent,
      103,
    )
    llm.enqueue(() => ({
      content: [{ type: 'text', text: 'ACCOUNT_002_RECOVERED' }],
      headers: rateHeaders('allowed', 0.1),
    }))
    assert.equal(await modelTurn(client, thread.id), 'completed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary.usedPercent,
      10,
    )
    llm.enqueue(() => ({
      content: [{ type: 'text', text: 'ACCOUNT_002_INVALID_METADATA' }],
      headers: rateHeaders('allowed', 21474836.48),
    }))
    assert.equal(await modelTurn(client, other.id), 'completed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary.usedPercent,
      10,
      '不能把超出int32的元数据写入协议或污染已有观测',
    )
    await client.close()
    client = await ProtocolClient.start(home, url, false, 'oauth')
    const restarted = (await client.request('account/rateLimits/read', null)).rateLimits
    assert.equal(restarted.primary, null, '重启不能复用先前进程观测的额度')
    assert.equal(restarted.secondary, null)
    assert.equal(notifications(client).length, 0, '未知状态不发送冒充清空客户端缓存的通知')
    llm.assertConsumed()
  } finally {
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('ACCOUNT-002：凭据变更清空观测，旧回合和不同项目 provider 不能回填默认账户', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-rate-identity-'))
  const llm = new MockLLM()
  const url = await llm.start()
  const client = await ProtocolClient.start(home, url, false, 'oauth')
  const settingsPath = join(home, 'claude', 'settings.json')
  let releaseOld = () => {}
  try {
    const { thread } = await client.request('thread/start', { cwd: home })
    const reply = (utilization: number) => ({
      content: [{ type: 'text', text: 'ACCOUNT_002_IDENTITY' }],
      headers: rateHeaders('allowed', utilization),
    })
    llm.enqueue((_body, headers) => {
      assert.equal(headers.authorization, 'Bearer sk-ant-oat01-test-not-a-secret')
      return reply(0.2)
    })
    assert.equal(await modelTurn(client, thread.id), 'completed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary.usedPercent,
      20,
    )
    let observedOld!: () => void
    const oldStarted = new Promise<void>((resolve) => {
      observedOld = resolve
    })
    const oldResponse = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    llm.enqueue(async (_body, headers) => {
      assert.equal(headers.authorization, 'Bearer sk-ant-oat01-test-not-a-secret')
      observedOld()
      await oldResponse
      return reply(0.8)
    })
    const { turn: oldTurn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'ACCOUNT_002 等待旧凭据响应' }],
    })
    await oldStarted
    const newSettings = { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-new-test-not-a-secret' } }
    await writeFile(settingsPath, JSON.stringify(newSettings), { mode: 0o600 })
    assert.equal((await client.request('account/rateLimits/read', null)).rateLimits.primary, null)
    const before = notifications(client).length
    releaseOld()
    assert.equal((await client.completed(oldTurn.id)).status, 'completed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary,
      null,
      '旧SDK启动时的身份不能回填新的账户',
    )
    assert.equal(notifications(client).length, before)
    llm.enqueue((_body, headers) => {
      assert.equal(headers.authorization, 'Bearer sk-ant-oat01-new-test-not-a-secret')
      return reply(0.3)
    })
    assert.equal(await modelTurn(client, thread.id), 'completed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary.usedPercent,
      30,
    )
    const project = join(home, 'other-project')
    await mkdir(join(project, '.claude'), { recursive: true })
    await writeFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-project-test-not-a-secret' },
      }),
      { mode: 0o600 },
    )
    const { thread: other } = await client.request('thread/start', { cwd: project })
    llm.enqueue((_body, headers) => {
      assert.equal(headers.authorization, 'Bearer sk-ant-oat01-project-test-not-a-secret')
      return reply(0.7)
    })
    assert.equal(await modelTurn(client, other.id), 'completed')
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary.usedPercent,
      30,
      '项目账户不能覆盖默认账户',
    )
    await writeFile(
      settingsPath,
      JSON.stringify({ ...newSettings, apiKeyHelper: 'do-not-run-this-helper' }),
    )
    assert.equal(
      (await client.request('account/rateLimits/read', null)).rateLimits.primary,
      null,
      '动态凭据来源只能返回unknown',
    )
    await writeFile(settingsPath, JSON.stringify(newSettings))
    assert.equal((await client.request('account/rateLimits/read', null)).rateLimits.primary, null)
    llm.assertConsumed()
  } finally {
    releaseOld()
    await client.close()
    await llm.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
