import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { McpOAuthManager } from '../src/mcp-oauth.mjs'
import { saveArtifact } from './fixtures/artifacts.mjs'
import { OAuthDaemonFixture, OAuthMcpFixture } from './fixtures/mcp-oauth.mjs'
import { MockLLM } from './fixtures/mock-llm.mjs'
import { ProtocolClient } from './fixtures/protocol-client.mjs'

const mcpConfig = (url: string, type: 'http' | 'sse' = 'http') => ({
  secure: { url, type, http_headers: { 'X-Resource-Only': 'resource-test-secret' } },
})
async function configure(client: ProtocolClient, url: string, type: 'http' | 'sse' = 'http') {
  await client.request('config/value/write', {
    keyPath: 'mcp_servers',
    value: mcpConfig(url, type),
    mergeStrategy: 'replace',
  })
}
async function authorize(client: ProtocolClient): Promise<string> {
  const { authorizationUrl } = await client.request('mcpServer/oauth/login', {
    name: 'secure',
    timeoutSecs: 10,
  })
  const response = await fetch(authorizationUrl, { redirect: 'manual' })
  assert.equal(response.status, 302)
  return response.headers.get('location')!
}
async function oauthFixture(
  run: (
    home: string,
    fixture: OAuthMcpFixture,
    model: MockLLM,
    client: ProtocolClient,
  ) => Promise<void>,
  type: 'http' | 'sse' = 'http',
) {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-oauth-edge-'))
  const fixture = new OAuthMcpFixture(join(home, 'effect.txt'), type)
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    await configure(client, await fixture.start(), type)
    await run(home, fixture, model, client)
    assert.deepEqual(fixture.errors, [])
    model.assertConsumed()
  } finally {
    await saveArtifact('oauth-results', {
      transport: type,
      tokenRequests: fixture.tokenRequests,
      exchanges: fixture.exchanges,
      refreshes: fixture.refreshes,
      effects: fixture.effects,
      modelCalls: model.requests.length,
      authorizedRequests: fixture.authorizedRequests,
    })
    await client.close()
    await model.close()
    await fixture.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('MCP-011：真实 SDK OAuth PKCE、并发刷新、重启与配置范围隔离', {
  timeout: 90_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-oauth-'))
  const file = join(home, 'oauth-effect.txt')
  const fixture = new OAuthMcpFixture(file)
  const model = new MockLLM()
  const config = {
    secure: {
      url: await fixture.start(),
      http_headers: { 'X-Resource-Only': 'resource-test-secret' },
    },
  }
  const endpoint = await model.start()
  let client = await ProtocolClient.start(home, endpoint)
  try {
    await client.request('config/value/write', {
      keyPath: 'mcp_servers',
      value: config,
      mergeStrategy: 'replace',
    })
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.equal(model.requests.length, 0)
    const login = await client.request('mcpServer/oauth/login', {
      name: 'secure',
      scopes: ['fixture:write'],
      timeoutSecs: 30,
    })
    const authorization = new URL(login.authorizationUrl)
    assert.equal(authorization.origin, fixture.issuer)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(authorization.searchParams.get('scope'), 'fixture:write')
    assert.ok((authorization.searchParams.get('state')?.length ?? 0) >= 43)
    const wrong = new URL(authorization.searchParams.get('redirect_uri')!)
    wrong.searchParams.set('state', 'wrong-state')
    wrong.searchParams.set('code', 'wrong-code')
    assert.equal((await fetch(wrong)).status, 400)
    assert.equal(fixture.exchanges, 0)
    const authorize = await fetch(authorization, { redirect: 'manual' })
    const callback = authorize.headers.get('location')!
    assert.equal((await fetch(callback)).status, 200)
    assert.equal((await client.notification('mcpServer/oauthLogin/completed')).success, true)
    const replay = await fetch(callback).then(
      (r) => r.status,
      () => 0,
    )
    assert.ok(replay === 400 || replay === 0, '成功回调必须不可重放')
    assert.equal(fixture.exchanges, 1)
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
    const directory = join(home, 'adapter', 'mcp-oauth')
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    const credentials = await readdir(directory)
    assert.equal(credentials.length, 1)
    assert.equal((await stat(join(directory, credentials[0]!))).mode & 0o777, 0o600)
    const run = async () => {
      model.enqueue((request) => {
        assert.ok(request.tools.some((tool: any) => tool.name === 'mcp__secure__oauth_write'))
        assert.ok(!JSON.stringify(request).includes(fixture.token))
        return [
          {
            type: 'tool_use',
            id: 'toolu_oauth_' + fixture.effects,
            name: 'mcp__secure__oauth_write',
            input: {},
          },
        ]
      })
      model.enqueue((request) => {
        assert.match(JSON.stringify(request.messages), /OAUTH_REAL_EFFECT/)
        return [{ type: 'text', text: 'OAUTH_SDK_DONE' }]
      })
      const { thread } = await client.request('thread/start', {
        cwd: home,
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
      })
      const { turn } = await client.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: 'Use the authorized MCP tool to append one line.' }],
      })
      assert.equal((await client.completed(turn.id)).status, 'completed')
    }
    await run()
    assert.equal(await readFile(file, 'utf8'), 'OAUTH_REAL_EFFECT\n')
    fixture.rotate()
    const statuses = await Promise.all([
      client.request('mcpServerStatus/list'),
      client.request('mcpServerStatus/list'),
    ])
    assert.ok(statuses.every((result) => result.data[0].authStatus === 'oAuth'))
    assert.equal(fixture.refreshes, 1, '并发401只能交换一次 refresh_token')
    const isolated = await client.request('thread/start', {
      cwd: home,
      config: { mcp_servers: config },
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    assert.equal(
      (await client.request('mcpServerStatus/list', { threadId: isolated.thread.id })).data[0]
        .authStatus,
      'notLoggedIn',
    )
    assert.equal(fixture.effects, 1)
    await client.close()
    client = await ProtocolClient.start(home, endpoint)
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
    await run()
    assert.equal(await readFile(file, 'utf8'), 'OAUTH_REAL_EFFECT\nOAUTH_REAL_EFFECT\n')
    assert.equal(fixture.effects, 2)
    assert.equal(fixture.refreshes, 1)
    assert.ok(!JSON.stringify(client.trace).includes(fixture.token))
    assert.ok(!JSON.stringify(client.trace).includes(fixture.refreshToken))
    assert.deepEqual(fixture.errors, [])
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await fixture.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('MCP-012：OAuth 拒绝、超时和配置错误不产生凭据或模型副作用', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-oauth-failure-'))
  const fixture = new OAuthMcpFixture(join(home, 'must-not-exist'))
  const model = new MockLLM()
  const client = await ProtocolClient.start(home, await model.start())
  try {
    await client.request('config/value/write', {
      keyPath: 'mcp_servers',
      value: {
        secure: {
          url: await fixture.start(),
          http_headers: { 'X-Resource-Only': 'resource-test-secret' },
        },
      },
      mergeStrategy: 'replace',
    })
    for (const params of [
      { name: 'missing' },
      { name: 'secure', scopes: ['space scope'] },
      { name: 'secure', timeoutSecs: 0 },
    ])
      await client.raw('mcpServer/oauth/login', params, -32602)
    const login = await client.request('mcpServer/oauth/login', { name: 'secure', timeoutSecs: 10 })
    await client.raw('mcpServer/oauth/login', { name: 'secure' }, -32009)
    const url = new URL(login.authorizationUrl)
    const callback = new URL(url.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', url.searchParams.get('state')!)
    callback.searchParams.set('error', 'access_denied')
    assert.equal((await fetch(callback)).status, 400)
    assert.equal((await client.notification('mcpServer/oauthLogin/completed')).success, false)
    await client.request('mcpServer/oauth/login', { name: 'secure', timeoutSecs: 1 })
    const timeout = await client.notification(
      'mcpServer/oauthLogin/completed',
      (value) => value.error === 'OAuth 登录已超时',
    )
    assert.equal(timeout.success, false)
    fixture.wrongIssuer = true
    await client.raw('mcpServer/oauth/login', { name: 'secure' }, -32001)
    fixture.wrongIssuer = false
    fixture.wrongResource = true
    await client.raw('mcpServer/oauth/login', { name: 'secure' }, -32001)
    assert.deepEqual(await readdir(join(home, 'adapter', 'mcp-oauth')).catch(() => []), [])
    assert.equal(fixture.exchanges, 0)
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
    assert.deepEqual(fixture.errors, [])
    model.assertConsumed()
  } finally {
    await client.close()
    await model.close()
    await fixture.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('MCP-012：真实 token 交换 500 不覆盖原凭据且失败回调不可重放', {
  timeout: 60_000,
}, async () => {
  await oauthFixture(async (home, fixture, model, client) => {
    assert.equal((await fetch(await authorize(client))).status, 200)
    const directory = join(home, 'adapter', 'mcp-oauth')
    const [name] = await readdir(directory)
    const previous = await readFile(join(directory, name!), 'utf8')
    const callback = await authorize(client)
    fixture.failToken = true
    assert.equal((await fetch(callback)).status, 400)
    const completed = await client.notification('mcpServer/oauthLogin/completed', (p) => !p.success)
    assert.equal(completed.error, 'OAuth 授权码交换或凭据保存失败')
    assert.equal(fixture.tokenRequests, 2)
    assert.equal(fixture.exchanges, 1)
    assert.equal(await readFile(join(directory, name!), 'utf8'), previous)
    assert.ok(
      [0, 400].includes(
        await fetch(callback).then(
          (r) => r.status,
          () => 0,
        ),
      ),
    )
    assert.equal(fixture.tokenRequests, 2)
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
  })
})

test('MCP-012：开始授权后凭据目录变成文件，保存失败不能假成功或保留内存认证', {
  timeout: 60_000,
}, async () => {
  await oauthFixture(async (home, fixture, model, client) => {
    const callback = await authorize(client)
    const directory = join(home, 'adapter', 'mcp-oauth')
    await writeFile(directory, 'PRESERVE_DIRECTORY_FAILURE', { mode: 0o600 })
    assert.equal((await fetch(callback)).status, 400)
    const completed = await client.notification('mcpServer/oauthLogin/completed')
    assert.equal(completed.success, false)
    assert.equal(fixture.exchanges, 1, '必须在真实交换成功之后注入磁盘写失败')
    assert.equal(await readFile(directory, 'utf8'), 'PRESERVE_DIRECTORY_FAILURE')
    await rm(directory)
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
    assert.ok(!JSON.stringify(client.trace).includes(fixture.token))
  })
})

test('MCP-012：OAuth 凭据目录符号链接必须在读取和登录前拒绝', { timeout: 60_000 }, async () => {
  await oauthFixture(async (home, fixture, model, client) => {
    assert.equal((await fetch(await authorize(client))).status, 200)
    const directory = join(home, 'adapter', 'mcp-oauth')
    const outside = join(home, 'outside-credential-store')
    await rename(directory, outside)
    await symlink(outside, directory, 'dir')
    const before = fixture.bearerRequests
    await client.raw('mcpServerStatus/list', {}, -32001)
    await client.raw('mcpServer/oauth/login', { name: 'secure' }, -32001)
    assert.equal(fixture.bearerRequests, before, '不能使用符号链接目录中的 token 发起资源请求')
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
    await rm(directory)
    await rename(outside, directory)
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
  })
})

test('MCP-011：同来源 URL 改变与第二 HOME 不能复用原 OAuth 凭据', { timeout: 60_000 }, async () => {
  await oauthFixture(async (home, fixture, model, client) => {
    assert.equal((await fetch(await authorize(client))).status, 200)
    const original = fixture.url
    fixture.url = new URL('/changed-resource', original).href
    await configure(client, fixture.url)
    const before = fixture.bearerRequests
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.equal(fixture.bearerRequests, before, '改变路径不能继承同来源旧 token')
    fixture.url = original
    await configure(client, original)
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
    const other = await mkdtemp(join(tmpdir(), 'native-mcp-oauth-other-'))
    const secondModel = new MockLLM()
    const second = await ProtocolClient.start(other, await secondModel.start())
    try {
      await configure(second, original)
      const requests = fixture.bearerRequests
      assert.equal((await second.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
      assert.equal(fixture.bearerRequests, requests)
      assert.deepEqual(await readdir(join(other, 'adapter', 'mcp-oauth')).catch(() => []), [])
      assert.equal(secondModel.requests.length, 0)
      secondModel.assertConsumed()
    } finally {
      await second.close()
      await secondModel.close()
      await rm(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
    assert.equal(await stat(join(home, 'adapter', 'mcp-oauth')).then((s) => s.isDirectory()), true)
  })
})

test('MCP-011：真实 SSE OAuth 未登录、SDK 工具执行、并发刷新及失败状态', {
  timeout: 90_000,
}, async () => {
  await oauthFixture(async (home, fixture, model, client) => {
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.equal((await fetch(await authorize(client))).status, 200)
    model.enqueue((request) => {
      assert.ok(request.tools.some((tool: any) => tool.name === 'mcp__secure__oauth_write'))
      assert.ok(!JSON.stringify(request).includes(fixture.token))
      return [
        { type: 'tool_use', id: 'oauth_sse_real', name: 'mcp__secure__oauth_write', input: {} },
      ]
    })
    model.enqueue((request) => {
      assert.match(JSON.stringify(request.messages), /OAUTH_REAL_EFFECT/)
      return [{ type: 'text', text: 'SSE_OAUTH_REAL_DONE' }]
    })
    const { thread } = await client.request('thread/start', {
      cwd: home,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    })
    const { turn } = await client.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '执行一次 SSE OAuth MCP 写入工具。' }],
    })
    assert.equal((await client.completed(turn.id)).status, 'completed')
    assert.equal(await readFile(join(home, 'effect.txt'), 'utf8'), 'OAUTH_REAL_EFFECT\n')
    assert.equal(fixture.effects, 1)
    fixture.rotate()
    const statuses = await Promise.all([
      client.request('mcpServerStatus/list'),
      client.request('mcpServerStatus/list'),
    ])
    assert.ok(statuses.every((status) => status.data[0].authStatus === 'oAuth'))
    assert.equal(fixture.refreshes, 1)
    fixture.rotate()
    fixture.failToken = true
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.equal(fixture.tokenRequests, 3)
    assert.equal(fixture.effects, 1)
    assert.equal(model.requests.length, 2)
    assert.equal(await readFile(join(home, 'effect.txt'), 'utf8'), 'OAUTH_REAL_EFFECT\n')
    fixture.failToken = false
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'oAuth')
    assert.equal(fixture.refreshes, 2)
  }, 'sse')
})

test('MCP-012：真实 WebSocket 客户端断开后旧 OAuth 回调失效，守护进程继续服务新客户端', {
  timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-mcp-oauth-peer-'))
  const fixture = new OAuthMcpFixture(join(home, 'must-not-exist'))
  const model = new MockLLM()
  let daemon: OAuthDaemonFixture | undefined
  try {
    daemon = await OAuthDaemonFixture.start(home, await model.start())
    await daemon.request('config/value/write', {
      keyPath: 'mcp_servers',
      value: mcpConfig(await fixture.start()),
      mergeStrategy: 'replace',
    })
    const login = await daemon.request('mcpServer/oauth/login', { name: 'secure', timeoutSecs: 10 })
    const authorization = await fetch(login.authorizationUrl, { redirect: 'manual' })
    const callback = authorization.headers.get('location')!
    await daemon.disconnect()
    await daemon.connect()
    assert.equal(daemon.process.exitCode, null, '断开客户端不能偷换成重启整个适配器')
    assert.equal((await daemon.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.ok(
      [0, 400].includes(
        await fetch(callback).then(
          (r) => r.status,
          () => 0,
        ),
      ),
    )
    assert.equal(fixture.tokenRequests, 0)
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
    assert.deepEqual(await readdir(join(home, 'adapter', 'mcp-oauth')).catch(() => []), [])
    const fresh = await daemon.request('mcpServer/oauth/login', { name: 'secure', timeoutSecs: 10 })
    assert.notEqual(fresh.authorizationUrl, login.authorizationUrl)
    assert.deepEqual(fixture.errors, [])
    model.assertConsumed()
  } finally {
    await daemon?.close()
    await model.close()
    await fixture.close()
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('MCP-012：真实 OAuth 回调在 token 交换中断线，不能保存凭据或通知成功', {
  timeout: 60_000,
}, async () => {
  await oauthFixture(async (home, fixture, model, client) => {
    const callback = await authorize(client)
    const gate = fixture.pauseTokenExchange()
    const abort = new AbortController()
    const request = fetch(callback, { signal: abort.signal }).then(
      () => false,
      () => true,
    )
    try {
      await gate.started
      assert.equal(fixture.tokenRequests, 1)
      assert.equal(fixture.exchanges, 0)
      abort.abort()
      assert.equal(await request, true)
      await delay(100)
    } finally {
      gate.release()
    }
    const completed = await client.notification('mcpServer/oauthLogin/completed')
    assert.equal(completed.success, false, '失去回调连接后不能宣布授权成功')
    assert.deepEqual(await readdir(join(home, 'adapter', 'mcp-oauth')).catch(() => []), [])
    assert.equal((await client.request('mcpServerStatus/list')).data[0].authStatus, 'notLoggedIn')
    assert.equal(fixture.effects, 0)
    assert.equal(model.requests.length, 0)
  })
})

// 断开与迟到 token 在同一轮 I/O 到达时，适配器已读到的断开必须先于凭据提交生效。
for (const order of ['disconnect-first', 'token-first'] as const)
  test(`MCP-012：回调断开与迟到 token 同轮到达（${order}）不能接受凭据`, {
    timeout: 30_000,
  }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'native-mcp-oauth-late-'))
    const fixture = new OAuthMcpFixture(join(home, 'must-not-exist'))
    const manager = new McpOAuthManager(home)
    try {
      const config = {
        type: 'http',
        url: await fixture.start(),
        headers: { 'X-Resource-Only': 'resource-test-secret' },
      }
      let completed!: (value: { success: boolean }) => void
      const completion = new Promise<{ success: boolean }>((resolve) => {
        completed = resolve
      })
      const { authorizationUrl } = await manager.login(
        'user',
        config,
        { name: 'secure', timeoutSecs: 10 },
        'peer',
        completed,
      )
      const authorization = await fetch(authorizationUrl, { redirect: 'manual' })
      const callback = new URL(authorization.headers.get('location')!)
      const gate = fixture.pauseTokenExchange()
      const browser = connect(Number(callback.port), callback.hostname)
      browser.on('error', () => {})
      browser.resume()
      await new Promise((resolve) => browser.once('connect', resolve))
      browser.write(
        `GET ${callback.pathname}${callback.search} HTTP/1.1\r\nHost: ${callback.host}\r\n\r\n`,
      )
      await gate.started
      // 只让出微任务和 nextTick：token 响应与断开都已写出，但适配器尚未回到事件循环。
      const written = async () => {
        for (let i = 0; i < 100 && fixture.exchanges === 0; i++) await Promise.resolve()
        assert.equal(fixture.exchanges, 1)
        await new Promise((resolve) => process.nextTick(resolve))
      }
      if (order === 'disconnect-first') {
        browser.destroy()
        gate.release()
        await written()
      } else {
        gate.release()
        await written()
        browser.destroy()
      }
      // 回环投递可能异步；同步阻塞让两者都进入内核缓冲，下一轮 poll 同批看到断开和 token 响应。
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      assert.equal((await completion).success, false, '已断开的回调不能宣布授权成功')
      assert.equal(fixture.exchanges, 1, '迟到 token 响应必须真实产生')
      assert.deepEqual(await readdir(join(home, 'mcp-oauth')).catch(() => []), [])
      assert.equal(manager.status('user', 'secure', config), 'notLoggedIn')
      assert.equal(fixture.effects, 0)
      assert.deepEqual(fixture.errors, [])
    } finally {
      manager.close()
      await fixture.close()
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
