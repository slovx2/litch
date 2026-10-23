import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 供应商：真实 CLI 加回环上的假模型。会话按所选型号的供应商起 CLI——网关拿到自己的密钥和型号，
// 用户自己的配置（这里是启动环境里的 ANTHROPIC_API_KEY 和地址）照旧；同一会话下一回合可以换供应商；
// 没填密钥的供应商报错，不退回别的凭据。

async function writeProviders(home: string, baseUrl: string): Promise<void> {
  const adapter = join(home, 'adapter')
  await mkdir(adapter, { recursive: true })
  await writeFile(
    join(adapter, 'config.json'),
    JSON.stringify({
      overrides: {
        litch_providers: {
          providers: {
            corp: {
              kind: 'gateway',
              title: 'Corp',
              baseUrl,
              authHeader: 'bearer',
              models: [{ id: 'glm-4.6', title: 'GLM 4.6' }],
              headers: 'X-Team: litch',
            },
            work: { kind: 'apiKey', title: 'Work' },
          },
        },
      },
    }),
  )
  await writeFile(
    join(adapter, 'provider-secrets.json'),
    JSON.stringify({ secrets: { corp: 'gw-token-not-a-secret' } }),
    { mode: 0o600 },
  )
}

test('PROVIDERS-E2E-001：网关会话用它的密钥和型号，下一回合换回自己的配置，没填密钥的报错', {
  timeout: 150_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-providers-'))
  const model = new MockLLM()
  const url = await model.start()
  await writeProviders(home, url)
  await mkdir(join(home, 'claude'), { recursive: true })
  // 用户自己 settings.json 里的 key 和请求头：网关会话（托管模式）不带，用户自己的配置照带
  await writeFile(
    join(home, 'claude', 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'user-settings-key', ANTHROPIC_CUSTOM_HEADERS: 'X-User: 1' },
    }),
  )
  const client = await ProtocolClient.start(home, url)
  try {
    const list = (await client.request('model/list', {})).data as Array<{
      id: string
      displayName: string
    }>
    const corp = list.find((entry) => entry.id === 'corp/glm-4.6')
    assert.equal(corp?.displayName, '[Corp] GLM 4.6')
    // work 没填密钥不列；启动环境里的 key 和地址是用户自己的配置，列成 Claude Code
    assert.ok(!list.some((entry) => entry.id.startsWith('work/')))
    assert.ok(
      list.some((entry) => entry.id.startsWith('native/')),
      JSON.stringify(list),
    )
    assert.ok(!list.some((entry) => entry.id.startsWith('anthropic/')), '账号没登录不列')

    const seen: Array<{
      model: string
      authorization: unknown
      apiKey: unknown
      team: unknown
      user: unknown
    }> = []
    const reply = (text: string) => (request: any, headers: any) => {
      seen.push({
        model: request.model,
        authorization: headers.authorization,
        apiKey: headers['x-api-key'],
        team: headers['x-team'],
        user: headers['x-user'],
      })
      return [{ type: 'text', text }]
    }
    model.enqueue(reply('ONE'))
    const { thread } = await client.request('thread/start', { cwd: home, model: 'corp/glm-4.6' })
    assert.equal(thread.model ?? 'corp/glm-4.6', 'corp/glm-4.6')
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    assert.deepEqual(seen[0], {
      model: 'glm-4.6',
      authorization: 'Bearer gw-token-not-a-secret',
      apiKey: undefined,
      team: 'litch',
      user: undefined,
    })

    // 同一会话下一回合换成用户自己的配置
    model.enqueue(reply('TWO'))
    const second = await client.request('turn/start', {
      threadId: thread.id,
      model: 'native/claude-sonnet-4-6',
      input: [{ type: 'text', text: '再来' }],
    })
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    assert.equal(seen[1]?.model, 'claude-sonnet-4-6')
    // settings.json 的 env 盖过启动环境（CLI 自己的规矩）
    assert.equal(seen[1]?.apiKey, 'user-settings-key')
    assert.equal(seen[1]?.authorization, undefined)
    assert.equal(seen[1]?.team, undefined)
    assert.equal(seen[1]?.user, '1')
    model.assertConsumed()

    // 没填密钥的供应商：回合失败，说清楚原因，假模型收不到请求
    const before = model.requests.length
    const { thread: other } = await client.request('thread/start', {
      cwd: home,
      model: 'work/claude-sonnet-4-6',
    })
    const failed = await client.request('turn/start', {
      threadId: other.id,
      input: [{ type: 'text', text: '你好' }],
    })
    const turn = await client.completed(failed.turn.id)
    assert.equal(turn.status, 'failed')
    assert.match(JSON.stringify(turn.error), /密钥/)
    assert.equal(model.requests.length, before)
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PROVIDERS-E2E-002：账号会话不用 settings.json 和启动环境里别的地址和 key', {
  timeout: 150_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-providers-'))
  const model = new MockLLM()
  const url = await model.start()
  // 记下 CLI 经代理要连的地方：CONNECT 只记目标就断开，明文请求只记地址
  const targets: string[] = []
  const proxy = createServer((req, res) => {
    targets.push(req.url ?? '')
    res.destroy()
  })
  proxy.on('connect', (req, socket) => {
    targets.push(req.url ?? '')
    socket.destroy()
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const adapter = join(home, 'adapter')
  await mkdir(adapter, { recursive: true })
  await mkdir(join(home, 'claude'), { recursive: true })
  await writeFile(
    join(adapter, 'provider-secrets.json'),
    JSON.stringify({ secrets: { anthropic: 'sk-ant-oat01-test-not-a-secret' } }),
    { mode: 0o600 },
  )
  await writeFile(
    join(home, 'claude', 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'user-settings-key' },
    }),
  )
  const client = await ProtocolClient.start(home, url, false, 'api-key', {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
  })
  try {
    const list = (await client.request('model/list', {})).data as Array<{ id: string }>
    assert.ok(
      list.some((entry) => entry.id.startsWith('anthropic/')),
      JSON.stringify(list),
    )
    const { thread } = await client.request('thread/start', {
      cwd: home,
      model: 'anthropic/sonnet',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    const deadline = Date.now() + 60_000
    while (!targets.includes('api.anthropic.com:443') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(targets.includes('api.anthropic.com:443'), JSON.stringify(targets))
    await client.request('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    await client.completed(turn.id)
    // 进程环境和 settings.json 里的地址都没用上（apiKeyHelper 置空由 HC-CLAUDE-006 守着：
    // 这里 settings.json 另配了服务，用户自己那一家的目录查询会照常跑它，分不出是谁跑的）
    assert.equal(model.requests.length + model.titleRequests.length, 0)
    assert.ok(!targets.some((target) => target.includes('127.0.0.1')), JSON.stringify(targets))
  } finally {
    await client.close()
    await model.close()
    await new Promise((resolve) => proxy.close(resolve))
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
