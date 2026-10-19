// 原生 codex 的 provider、账号、MCP、指令文件（设备进程翻译）。配置项在 codex-harness-config.test.mts。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { codexRig } from './codex-kit.mjs'
import { FakeCodex } from './fake-codex.mjs'
import { installConfig } from './fake-codex-config.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import {
  AUTH_UPDATED,
  assertHcError,
  assertHcNotification,
  assertHcResponse,
  CHANGED,
} from './hc-kit.mjs'
import { settle, tempDir } from './helpers.mjs'

const DECLARED = ['harness', 'harnessConfig']
const CODEX = { harness: 'codex' }

async function setup(codexHome?: string) {
  const fake = new FakeCodex()
  if (codexHome) {
    const greet = fake.handlers.initialize as (params: any, connection: any) => any
    fake.handlers.initialize = (params, connection) => ({ ...greet(params, connection), codexHome })
  }
  const env = codexRig({ fake })
  const state = installConfig(env.codex)
  const client = env.connect()
  await client.initialize(DECLARED)
  return { env, state, client }
}

const ids = (read: any) => read.providers.map((item: any) => [item.id, item.kind, item.active])

test('providers：openai、本机的两个是自带的；自定义的增、切、删（删在用的那个时切回 openai）', async () => {
  const { env, state, client } = await setup()
  try {
    const read = await client.call('litch/harness/providers/read', CODEX)
    assertHcResponse('litch/harness/providers/read', read)
    assert.equal(read.switchable, true)
    assert.deepEqual(ids(read), [
      ['openai', 'builtin', true],
      ['ollama', 'builtin', false],
      ['lmstudio', 'builtin', false],
    ])
    assert.deepEqual(
      read.providers[0].methods.map((method: any) => [method.id, method.kind]),
      [
        ['chatgpt', 'oauthBrowser'],
        ['chatgptDeviceCode', 'oauthDeviceCode'],
        ['apiKey', 'apiKey'],
      ],
    )
    const upsert = await client.call('litch/harness/providers/upsert', {
      ...CODEX,
      providerId: 'gw',
      templateId: 'openaiCompatible',
      definition: { name: 'Gateway', base_url: 'http://127.0.0.1:9/v1', env_key: 'GW_KEY' },
      expectedVersion: read.version,
    })
    assertHcResponse('litch/harness/providers/upsert', upsert)
    assert.deepEqual(state.user.model_providers.gw, {
      name: 'Gateway',
      base_url: 'http://127.0.0.1:9/v1',
      env_key: 'GW_KEY',
      wire_api: 'responses',
      requires_openai_auth: false,
    })
    // 模板以外的字段（手写的 http_headers）改的时候原样留着
    state.user.model_providers.gw.http_headers = { 'X-Team': 'a' }
    const second = await client.call('litch/harness/providers/upsert', {
      ...CODEX,
      providerId: 'gw',
      templateId: 'openaiCompatible',
      definition: { base_url: 'http://127.0.0.1:10/v1' },
      expectedVersion: (await client.call('litch/harness/providers/read', CODEX)).version,
    })
    assert.deepEqual(state.user.model_providers.gw.http_headers, { 'X-Team': 'a' })
    const active = await client.call('litch/harness/providers/activate', {
      ...CODEX,
      providerId: 'gw',
      expectedVersion: second.version,
    })
    assert.equal(state.user.model_provider, 'gw')
    const after = await client.call('litch/harness/providers/read', CODEX)
    const gw = after.providers.find((item: any) => item.id === 'gw')
    assert.deepEqual([gw.kind, gw.active, gw.templateId], ['custom', true, 'openaiCompatible'])
    assert.deepEqual(gw.methods, [
      {
        id: 'env',
        kind: 'env',
        title: gw.methods[0].title,
        description: null,
        envName: 'GW_KEY',
        effect: 'harness',
      },
    ])
    // 设备设置里没填这个变量
    assert.deepEqual([gw.auth.signedIn, gw.auth.kind], [false, 'none'])
    const missing = await client.fails('litch/harness/providers/activate', {
      ...CODEX,
      providerId: 'zzz',
      expectedVersion: active.version,
    })
    assert.equal(missing.data.litch, 'notFound')
    const reserved = await client.fails('litch/harness/providers/upsert', {
      ...CODEX,
      providerId: 'openai',
      templateId: 'openaiCompatible',
      definition: { name: 'x' },
      expectedVersion: active.version,
    })
    assert.equal(reserved.data.litch, 'readOnly')
    for (const error of [missing, reserved]) assertHcError(error.data)
    await client.call('litch/harness/providers/remove', { ...CODEX, providerId: 'gw' })
    assert.equal(state.user.model_providers.gw, undefined)
    assert.equal(state.user.model_provider, undefined, '删掉在用的那个时一并删掉 model_provider')
    const gone = await client.fails('litch/harness/providers/remove', {
      ...CODEX,
      providerId: 'gw',
    })
    assert.equal(gone.data.litch, 'notFound')
  } finally {
    await env.close()
  }
})

test('自定义 provider 的 key：设备设置里 harness.codex.env 填了 env_key 那个变量就算有', async () => {
  const control = new FakeControl([managed('pi'), { ...managed('codex'), native: true }])
  const state0 = control.state
  if (state0) state0.snapshot.values['harness.codex.env'] = [{ name: 'GW_KEY', secret: true }]
  const env = codexRig({ device: { control } })
  const state = installConfig(env.codex)
  state.user = {
    model_providers: { gw: { name: 'GW', env_key: 'GW_KEY', requires_openai_auth: false } },
  }
  try {
    const client = env.connect()
    await client.initialize(DECLARED)
    const read = await client.call('litch/harness/providers/read', CODEX)
    const gw = read.providers.find((item: any) => item.id === 'gw')
    assert.deepEqual(gw.auth, { signedIn: true, kind: 'env', label: 'GW_KEY' })
    const refused = await client.fails('litch/harness/auth/start', {
      ...CODEX,
      providerId: 'gw',
      methodId: 'env',
    })
    assert.equal(refused.data.litch, 'invalidValue')
  } finally {
    await env.close()
  }
})

test('ChatGPT 登录：浏览器的给授权链接和回调端口，设备码给网址和码；结果只告诉发起的那条连接，成了告诉所有声明过的', async () => {
  const { env, state, client } = await setup()
  try {
    const other = env.connect()
    await other.initialize(DECLARED)
    const browser = await client.call('litch/harness/auth/start', {
      ...CODEX,
      providerId: 'openai',
      methodId: 'chatgpt',
    })
    assertHcResponse('litch/harness/auth/start', browser)
    assert.equal(browser.step.kind, 'openUrl')
    assert.equal(browser.step.callbackPort, 1455)
    assert.match(browser.step.url, /^https:\/\/auth\.openai\.com\//)
    // 再开一次设备码：codex 让上一次以失败结束，进展告诉这条连接
    const device = await client.call('litch/harness/auth/start', {
      ...CODEX,
      providerId: 'openai',
      methodId: 'chatgptDeviceCode',
    })
    assert.deepEqual(device.step, {
      kind: 'deviceCode',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
      message: device.step.message,
    })
    const failed = await client.waitFor(
      (frame) =>
        frame.method === AUTH_UPDATED && (frame.params as any).attemptId === browser.attemptId,
    )
    assertHcNotification(AUTH_UPDATED, failed.params)
    assert.equal((failed.params as any).step.kind, 'failed')
    assert.equal((failed.params as any).providerId, 'openai')
    // 用户在浏览器里输了码：codex 说成了
    state.account = { type: 'chatgpt', email: 'me@example.com', planType: 'plus' }
    env.codex.notify('account/login/completed', {
      loginId: device.attemptId,
      success: true,
      error: null,
    })
    const done = await client.waitFor(
      (frame) =>
        frame.method === AUTH_UPDATED && (frame.params as any).attemptId === device.attemptId,
    )
    assert.deepEqual((done.params as any).step, {
      kind: 'done',
      auth: { signedIn: true, kind: 'oauth', label: 'me@example.com · plus' },
    })
    for (const peer of [client, other])
      await peer.waitFor(
        (frame) => frame.method === CHANGED && (frame.params as any).part === 'providers',
      )
    await settle(30)
    assert.ok(!other.raw.some((text) => text.includes(AUTH_UPDATED)), '别的连接不收登录的进展')
    const read = await client.call('litch/harness/providers/read', CODEX)
    assert.deepEqual(read.providers[0].auth, {
      signedIn: true,
      kind: 'oauth',
      label: 'me@example.com · plus',
    })
    assert.equal(read.providers[0].canLogout, true)
  } finally {
    await env.close()
  }
})

test('API key、取消、登出', async () => {
  const { env, state, client } = await setup()
  try {
    const key = await client.call('litch/harness/auth/start', {
      ...CODEX,
      providerId: 'openai',
      methodId: 'apiKey',
      inputs: { apiKey: 'sk-test-1' },
    })
    assert.deepEqual(key.step, {
      kind: 'done',
      auth: { signedIn: true, kind: 'apiKey', label: null },
    })
    const empty = await client.fails('litch/harness/auth/start', {
      ...CODEX,
      providerId: 'openai',
      methodId: 'apiKey',
      inputs: {},
    })
    assert.equal(empty.data.litch, 'invalidValue')
    const started = await client.call('litch/harness/auth/start', {
      ...CODEX,
      providerId: 'openai',
      methodId: 'chatgpt',
    })
    assert.deepEqual(
      await client.call('litch/harness/auth/cancel', { ...CODEX, attemptId: started.attemptId }),
      {},
    )
    assert.equal(state.login, null)
    const gone = await client.fails('litch/harness/auth/cancel', {
      ...CODEX,
      attemptId: started.attemptId,
    })
    assert.equal(gone.data.litch, 'notFound')
    const nothing = await client.fails('litch/harness/auth/continue', {
      ...CODEX,
      attemptId: 'x',
      inputs: {},
    })
    assert.equal(nothing.data.litch, 'notFound')
    await client.call('litch/harness/auth/logout', { ...CODEX, providerId: 'openai' })
    assert.equal(state.account, null)
  } finally {
    await env.close()
  }
})

test('MCP：读（密钥类的 env 不回显）、改名、保留密钥、加 HTTP 的、删、OAuth 登录', async () => {
  const { env, state, client } = await setup()
  try {
    state.user = {
      mcp_servers: {
        demo: {
          command: 'echo',
          args: ['hi'],
          env: { API_TOKEN: 's3cret', PLAIN: '1' },
          tool_timeout_sec: 30,
        },
      },
    }
    const read = await client.call('litch/harness/mcp/read', CODEX)
    assertHcResponse('litch/harness/mcp/read', read)
    assert.deepEqual(read.servers[0], {
      name: 'demo',
      transport: 'stdio',
      enabled: true,
      command: 'echo',
      args: ['hi'],
      env: { API_TOKEN: '', PLAIN: '1' },
      secretKeys: ['API_TOKEN'],
      extra: { tool_timeout_sec: 30 },
      status: { state: 'connected', message: null },
    })
    const renamed = await client.call('litch/harness/mcp/upsert', {
      ...CODEX,
      previousName: 'demo',
      server: { ...read.servers[0], name: 'demo2', status: undefined },
      expectedVersion: read.version,
    })
    assertHcResponse('litch/harness/mcp/upsert', renamed)
    assert.equal(state.user.mcp_servers.demo, undefined)
    assert.deepEqual(state.user.mcp_servers.demo2, {
      tool_timeout_sec: 30,
      command: 'echo',
      args: ['hi'],
      env: { API_TOKEN: 's3cret', PLAIN: '1' },
    })
    const added = await client.call('litch/harness/mcp/upsert', {
      ...CODEX,
      server: {
        name: 'web',
        transport: 'http',
        enabled: true,
        url: 'https://mcp.example.com/mcp',
        bearerTokenEnvVar: 'WEB_TOKEN',
      },
      expectedVersion: renamed.version,
    })
    assert.deepEqual(state.user.mcp_servers.web, {
      url: 'https://mcp.example.com/mcp',
      bearer_token_env_var: 'WEB_TOKEN',
    })
    assert.equal(state.reloads, 2, '改完让 codex 重载 MCP 配置')
    const sse = await client.fails('litch/harness/mcp/upsert', {
      ...CODEX,
      server: { name: 'old', transport: 'sse', enabled: true, url: 'https://x' },
      expectedVersion: added.version,
    })
    assert.equal(sse.data.litch, 'invalidValue')
    const login = await client.call('litch/harness/mcp/login', { ...CODEX, name: 'web' })
    assert.deepEqual([login.step.kind, login.step.callbackPort], ['openUrl', 49210])
    const status = await client.call('litch/harness/mcp/read', CODEX)
    assert.equal(status.servers.find((item: any) => item.name === 'web').status.state, 'needsAuth')
    env.codex.notify('mcpServer/oauthLogin/completed', {
      name: 'web',
      threadId: null,
      success: true,
    })
    const done = await client.waitFor(
      (frame) =>
        frame.method === AUTH_UPDATED && (frame.params as any).attemptId === login.attemptId,
    )
    assertHcNotification(AUTH_UPDATED, done.params)
    assert.equal((done.params as any).mcpServer, 'web')
    assert.equal((done.params as any).step.kind, 'done')
    await client.call('litch/harness/mcp/remove', {
      ...CODEX,
      name: 'web',
      expectedVersion: status.version,
    })
    assert.equal(state.user.mcp_servers.web, undefined)
    const missing = await client.fails('litch/harness/mcp/remove', {
      ...CODEX,
      name: 'web',
      expectedVersion: status.version,
    })
    assert.ok(['notFound', 'versionConflict'].includes(missing.data.litch))
  } finally {
    await env.close()
  }
})

test('指令文件：$CODEX_HOME/AGENTS.md，AGENTS.override.md 不是空的时报被盖住；写带 expectedHash', async () => {
  const home = tempDir()
  const { env, client } = await setup(home)
  try {
    const empty = await client.call('litch/harness/instructions/read', CODEX)
    assertHcResponse('litch/harness/instructions/read', empty)
    assert.deepEqual(empty, {
      path: join(home, 'AGENTS.md'),
      fileName: 'AGENTS.md',
      exists: false,
      content: '',
      hash: '',
      linkTarget: null,
      overriddenBy: null,
    })
    const written = await client.call('litch/harness/instructions/write', {
      ...CODEX,
      content: '# 规矩\n',
      expectedHash: '',
    })
    assert.equal(readFileSync(join(home, 'AGENTS.md'), 'utf8'), '# 规矩\n')
    const stale = await client.fails('litch/harness/instructions/write', {
      ...CODEX,
      content: 'x',
      expectedHash: '',
    })
    assert.equal(stale.data.litch, 'versionConflict')
    writeFileSync(join(home, 'AGENTS.override.md'), '  \n')
    assert.equal(
      (await client.call('litch/harness/instructions/read', CODEX)).overriddenBy,
      null,
      '空的不算',
    )
    writeFileSync(join(home, 'AGENTS.override.md'), '盖住\n')
    const read = await client.call('litch/harness/instructions/read', CODEX)
    assert.equal(read.overriddenBy, join(home, 'AGENTS.override.md'))
    assert.equal(read.hash, written.hash)
    await client.waitFor(
      (frame) => frame.method === CHANGED && (frame.params as any).part === 'instructions',
    )
  } finally {
    await env.close()
  }
})
