import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { requiredClaudeCli } from './fixtures/claude-cli.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

// 供应商：真实 CLI 加回环上的假模型。会话按所选型号的供应商起 CLI——网关拿到自己的密钥和型号，
// 用户自己的配置（这里是启动环境里的 ANTHROPIC_API_KEY 和地址）照旧；同一会话下一回合可以换供应商；
// 没填密钥的供应商报错，不退回别的凭据。

async function writeProviders(
  home: string,
  baseUrl: string,
  contextWindow?: number,
): Promise<void> {
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
              models: [{ id: 'glm-4.6', title: 'GLM 4.6', contextWindow }],
            },
            work: { kind: 'apiKey', title: 'Work' },
          },
        },
      },
    }),
  )
  await writeFile(
    join(adapter, 'provider-secrets.json'),
    JSON.stringify({
      secrets: { corp: 'gw-token-not-a-secret', 'corp:headers': 'X-Team: litch' },
    }),
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

test('PROVIDERS-E2E-004：网关型号配的上下文窗口交给 CLI，用量按它报；后台命令上限给到 24 小时', {
  timeout: 150_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-providers-'))
  const model = new MockLLM()
  const url = await model.start()
  await writeProviders(home, url, 1_000_000)
  const client = await ProtocolClient.start(home, url)
  try {
    let tools: any[] = []
    model.enqueue((request: any) => {
      tools = request.tools ?? []
      return [{ type: 'text', text: 'OK' }]
    })
    const { thread } = await client.request('thread/start', { cwd: home, model: 'corp/glm-4.6' })
    const turn = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    assert.equal((await client.completed(turn.turn.id)).status, 'completed')
    // CLI 认不出 glm-4.6，没有这个窗口时按 200K 算
    const usage = await client.notification(
      'thread/tokenUsage/updated',
      (params) => params.threadId === thread.id && params.tokenUsage.modelContextWindow !== null,
    )
    assert.equal(usage.tokenUsage.modelContextWindow, 1_000_000)
    // 写给模型看的 Bash 超时上限：前台的上限就是这个变量；后台那句（CLI 新一些的版本才有）按 24 小时写
    const bash = tools.find((tool) => tool.name === 'Bash')
    assert.ok(bash, `没有 Bash 工具：${tools.map((tool) => tool.name).join(',')}`)
    const schema = JSON.stringify(bash.input_schema)
    assert.match(schema, /max 86400000/)
    const background = `${bash.description}${schema}`.match(/max \d+ms \/ (\d+) hours/)
    if (background) assert.equal(background[1], '24')
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PROVIDERS-E2E-002：账号会话不用 settings.json 和启动环境里别的地址、key 和型号映射', {
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
      env: {
        ANTHROPIC_BASE_URL: url,
        ANTHROPIC_API_KEY: 'user-settings-key',
        // 写给自家网关的型号映射：账号的 sonnet 不能被映射过去
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.6-gateway',
      },
    }),
  )
  const client = await ProtocolClient.start(home, url, false, 'api-key', {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
  })
  try {
    const list = (await client.request('model/list', {})).data as Array<{
      id: string
      displayName: string
      description: string
    }>
    assert.ok(
      list.some((entry) => entry.id.startsWith('anthropic/')),
      JSON.stringify(list),
    )
    // 账号的目录按账号起 CLI 时的设置问：settings.json 里写给网关的 sonnet 映射用不上；
    // 用户自己的配置照用（对照）
    const sonnet = (provider: string) => list.find((entry) => entry.id === `${provider}/sonnet`)
    assert.doesNotMatch(JSON.stringify(sonnet('anthropic')), /glm|Custom/, JSON.stringify(list))
    assert.match(String(sonnet('native')?.displayName), /glm-4\.6-gateway/)
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

test('PROVIDERS-E2E-003：回合中途换供应商不当场换；续接时型号名不变带着上一家的思考签名，换了型号名就去掉（c9t）', {
  timeout: 150_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-providers-'))
  const model = new MockLLM()
  const url = await model.start()
  const adapter = join(home, 'adapter')
  await mkdir(adapter, { recursive: true })
  const gateway = (models: string[]) => ({
    kind: 'gateway',
    baseUrl: url,
    authHeader: 'bearer',
    models: models.map((id) => ({ id })),
  })
  await writeFile(
    join(adapter, 'config.json'),
    JSON.stringify({
      overrides: {
        litch_providers: {
          providers: {
            a: gateway(['claude-sonnet-4-5']),
            b: gateway(['claude-sonnet-4-5']),
            c: gateway(['deepseek-v9']),
          },
        },
      },
    }),
  )
  await writeFile(
    join(adapter, 'provider-secrets.json'),
    JSON.stringify({ secrets: { a: 'token-a', b: 'token-b', c: 'token-c' } }),
    { mode: 0o600 },
  )
  const client = await ProtocolClient.start(home, url)
  const seen: Array<{ token: unknown; model: string; signatures: string[] }> = []
  const record = (request: any, headers: any) =>
    seen.push({
      token: headers.authorization,
      model: request.model,
      signatures: (request.messages as any[]).flatMap((message) =>
        Array.isArray(message.content)
          ? message.content.flatMap((block: any) =>
              block.type === 'thinking' ? [String(block.signature)] : [],
            )
          : [],
      ),
    })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    client.onServerRequest = async (_method, params) => {
      await held
      return { answers: { [params.questions[0].id]: { answers: ['继续'] } } }
    }
    model.enqueue((request, headers) => {
      record(request, headers)
      return [
        {
          type: 'tool_use',
          id: 'toolu_provider_switch',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '继续吗',
                header: '换供应商',
                multiSelect: false,
                options: [
                  { label: '继续', description: '继续' },
                  { label: '停止', description: '停止' },
                ],
              },
            ],
          },
        },
      ]
    })
    model.enqueue((request, headers) => {
      record(request, headers)
      return [
        { type: 'thinking', thinking: '想一想', signature: 'SIG-c9t-think-A' },
        { type: 'text', text: 'ONE' },
      ]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      model: 'a/claude-sonnet-4-5',
    })
    const first = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '第一轮' }],
    })
    await client.notification('item/tool/requestUserInput')
    // 凭据在 CLI 进程的环境里：回合中途换到别家不能当场换
    assert.deepEqual(
      await client.request('turn/settings/update', {
        threadId: thread.id,
        turnId: first.turn.id,
        model: 'b/claude-sonnet-4-5',
      }),
      { status: 'targetUnavailable' },
    )
    release()
    assert.equal((await client.completed(first.turn.id)).status, 'completed')
    assert.ok(seen.slice(0, 2).every((entry) => entry.token === 'Bearer token-a'))

    // 型号名不变换到 b：CLI 把 a 给的思考块连签名原样带给 b
    model.enqueue((request, headers) => {
      record(request, headers)
      return [{ type: 'text', text: 'TWO' }]
    })
    const second = await client.request('turn/start', {
      threadId: thread.id,
      model: 'b/claude-sonnet-4-5',
      input: [{ type: 'text', text: '第二轮' }],
    })
    assert.equal((await client.completed(second.turn.id)).status, 'completed')
    assert.equal(seen[2]?.token, 'Bearer token-b')
    assert.equal(seen[2]?.model, 'claude-sonnet-4-5')
    assert.deepEqual(seen[2]?.signatures, ['SIG-c9t-think-A'])

    // 换了型号名：历史里的思考块去掉
    model.enqueue((request, headers) => {
      record(request, headers)
      return [{ type: 'text', text: 'THREE' }]
    })
    const third = await client.request('turn/start', {
      threadId: thread.id,
      model: 'c/deepseek-v9',
      input: [{ type: 'text', text: '第三轮' }],
    })
    assert.equal((await client.completed(third.turn.id)).status, 'completed')
    assert.equal(seen[3]?.token, 'Bearer token-c')
    assert.equal(seen[3]?.model, 'deepseek-v9')
    assert.deepEqual(seen[3]?.signatures, [])
    model.assertConsumed()
  } finally {
    release()
    await client.close()
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// c13、c10 是 CLI 自己的规矩（供应商的做法靠它们）：直接起隔离的 CLI，对着回环上的假模型，
// 配置目录里放一份假的已保存订阅登录（只在用例目录里，不碰钥匙串之外的真实文件）
async function cliHome(): Promise<{ home: string; claude: string; credentials: string }> {
  const home = await mkdtemp(join(tmpdir(), 'provider-cli-'))
  const claude = join(home, 'claude')
  await mkdir(claude, { recursive: true })
  const credentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-saved-not-a-secret',
      refreshToken: 'sk-ant-ort01-saved-not-a-secret',
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  })
  await writeFile(join(claude, '.credentials.json'), credentials, { mode: 0o600 })
  return { home, claude, credentials }
}

function runCli(
  home: string,
  env: Record<string, string>,
): Promise<{ code: number | null; output: string }> {
  const child = spawn(requiredClaudeCli(), ['-p', '你好', '--output-format', 'json'], {
    cwd: home,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: home,
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      CLAUDE_CODE_TMPDIR: join(home, 'ct'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += String(chunk)
  })
  child.stderr.on('data', (chunk) => {
    output += String(chunk)
  })
  return new Promise((resolve) => child.once('close', (code) => resolve({ code, output })))
}

test('PROVIDERS-CLI-001：托管模式下不退回已保存的订阅登录（c13）', {
  timeout: 60_000,
}, async () => {
  const { home } = await cliHome()
  const model = new MockLLM()
  const url = await model.start()
  try {
    const { code, output } = await runCli(home, {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_BASE_URL: url,
    })
    assert.notEqual(code, 0)
    assert.match(output, /not logged in/i)
    assert.equal(model.requests.length + model.titleRequests.length, 0)
  } finally {
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('PROVIDERS-CLI-002：同一配置目录里订阅进程和 API key 进程同时跑，各用各的凭据，登录文件不变（c10）', {
  timeout: 150_000,
}, async () => {
  const { home, claude, credentials } = await cliHome()
  const model = new MockLLM()
  const url = await model.start()
  const seen: Array<{ authorization: unknown; apiKey: unknown }> = []
  model.fallback = (_request, headers) => {
    seen.push({ authorization: headers.authorization, apiKey: headers['x-api-key'] })
    return [{ type: 'text', text: 'OK' }]
  }
  try {
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([
        runCli(home, { ANTHROPIC_BASE_URL: url }),
        runCli(home, {
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
          ANTHROPIC_BASE_URL: url,
          ANTHROPIC_API_KEY: 'sk-ant-api-not-a-secret',
        }),
      ])
      for (const result of results) assert.equal(result.code, 0, result.output)
    }
    const subscription = seen.filter(
      (entry) => entry.authorization === 'Bearer sk-ant-oat01-saved-not-a-secret',
    )
    const apiKey = seen.filter((entry) => entry.apiKey === 'sk-ant-api-not-a-secret')
    assert.equal(subscription.length, 3, JSON.stringify(seen))
    assert.equal(apiKey.length, 3, JSON.stringify(seen))
    assert.ok(subscription.every((entry) => entry.apiKey === undefined))
    assert.ok(apiKey.every((entry) => entry.authorization === undefined))
    assert.equal(await readFile(join(claude, '.credentials.json'), 'utf8'), credentials)
  } finally {
    await model.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
