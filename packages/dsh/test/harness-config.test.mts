import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { HARNESS_CONFIG_METHOD as M } from '../../protocol/src/harness-config.mjs'
import { dshHome } from '../src/runtime.mjs'
import { DshServer } from '../src/server.mjs'
import { client, isolate } from './client.mjs'

// harness 详情设置（harnessConfig 扩展）对着真的 dsh（0.2.0-rc.2）：配置项、provider 与登录、MCP、AGENTS.md
// 都落在 DSH_HOME（测试里是临时目录）下 dsh 自己的文件上。DeepSeek 账号登录对着回环上的假平台走完整个流程。

type Scene = Awaited<ReturnType<typeof isolate>> & {
  server: DshServer
  desktop: ReturnType<typeof client>
  /** 没声明扩展的连接：收不到配置变化的通知 */
  plain: ReturnType<typeof client>
  home: string
  patch: string
}

async function scene(prelude = ''): Promise<Scene> {
  const env = await isolate((body) => [
    { type: 'text', chunks: [body.tools?.length ? '好的。' : 'mock 标题'] },
  ])
  const home = dshHome()
  assert.equal(home, join(env.root, 'home', 'dsh-home'), '前提：测试的 DSH_HOME 在临时目录里')
  const patch = join(home, 'profiles/web/cordis.patch.yml')
  if (prelude) {
    await mkdir(join(home, 'profiles/web'), { recursive: true })
    await writeFile(patch, prelude)
  }
  const server = new DshServer(join(env.root, 'home'))
  const desktop = client(server)
  await desktop.call('initialize', {
    clientInfo: { name: 'test', version: '0' },
    capabilities: { litchExtensions: [EXTENSION.harnessConfig] },
  })
  const plain = client(server)
  await plain.call('initialize', { clientInfo: { name: 'plain', version: '0' } })
  return { ...env, server, desktop, plain, home, patch }
}

async function dispose(s: Scene): Promise<void> {
  await s.server.close()
  await s.restore()
}

/** 调用应当失败，报的是 harnessConfig 的哪一种错误 */
async function refused(call: Promise<unknown>): Promise<string> {
  try {
    await call
  } catch (error: any) {
    return error.data?.litch ?? `code ${error.code}`
  }
  assert.fail('应当失败')
}

test('HARNESS-DSH-001：DSH_HOME 用用户的（没设是 ~/.dsh，空白的当没设），dsh 的会话也落在那里', async () => {
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(dshHome(), join(homedir(), '.dsh'))
    process.env.DSH_HOME = '   '
    assert.equal(dshHome(), join(homedir(), '.dsh'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
  const s = await scene()
  try {
    const info = await s.desktop.call('runtime/info', {})
    assert.ok(info.extensions.includes(EXTENSION.harnessConfig))
    const { thread } = await s.desktop.call('thread/start', { cwd: s.cwd })
    // dsh 到头一次落盘才建会话的文件：说一句话
    await s.desktop.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '你好' }],
    })
    await s.desktop.until('turn/completed')
    const stored = await readdir(join(s.home, 'sessions'), { recursive: true })
    assert.ok(
      stored.some((path) => path.includes(thread.id)),
      `会话应落在 DSH_HOME 里：${stored}`,
    )
    const listed = await s.desktop.call('thread/list', {})
    assert.ok(Array.isArray(listed.data))
  } finally {
    await dispose(s)
  }
})

test('HARNESS-DSH-002：配置项读写 dsh 自己的设置，版本对不上、只读项都拒绝，变化只通知声明过的连接', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const read = await s.desktop.call(M.configRead, { harness: 'dsh' })
    const keys = read.settings.map((one: any) => one.key)
    for (const key of [
      'agent-default-model.model',
      'agent-default-model.reasoningEffort',
      'permission.defaultPreset',
      'session-log-deepseek.enabled',
      'web-search-deepseek.enabled',
      'web-search-deepseek.apiKey',
      'subagent.maxDepth',
      'bash-sandbox.timeoutMs',
    ])
      assert.ok(keys.includes(key), `应有 ${key}`)
    assert.ok(
      read.settings.some((one: any) => one.key.startsWith('plugins.')),
      '应列出内置插件',
    )
    assert.equal(read.files[0].path, s.patch)
    const model = read.settings.find((one: any) => one.key === 'agent-default-model.model')
    const other = model.options.find((option: any) => option.value !== model.default)
    assert.ok(other, '前提：dsh 的模型目录里有别的模型')
    // 会话日志上传被 Litch 关着：只读
    const log = read.settings.find((one: any) => one.key === 'session-log-deepseek.enabled')
    assert.equal(log.readOnly, true)
    assert.equal(log.readOnlyReason['zh-CN'], '由 Litch 关闭')
    assert.equal(
      await refused(
        s.desktop.call(M.configWrite, {
          harness: 'dsh',
          edits: [{ key: log.key, value: true }],
          expectedVersion: read.version,
        }),
      ),
      'readOnly',
    )

    const written = await s.desktop.call(M.configWrite, {
      harness: 'dsh',
      edits: [
        { key: 'agent-default-model.model', value: other.value },
        { key: 'permission.defaultPreset', value: 'read-only' },
        { key: 'subagent.maxDepth', value: 2 },
        { key: 'web-search-deepseek.apiKeyEnv', value: 'LITCH_TEST_SEARCH_KEY' },
      ],
      expectedVersion: read.version,
    })
    assert.equal(written.restartRequired, false)
    assert.notEqual(written.version, read.version)
    // 拿旧版本再写：冲突
    assert.equal(
      await refused(
        s.desktop.call(M.configWrite, {
          harness: 'dsh',
          edits: [{ key: 'subagent.maxDepth', value: 3 }],
          expectedVersion: read.version,
        }),
      ),
      'versionConflict',
    )
    assert.equal(
      await refused(
        s.desktop.call(M.configWrite, {
          harness: 'dsh',
          edits: [{ key: 'subagent.maxDepth', value: 'x' }],
          expectedVersion: written.version,
        }),
      ),
      'invalidValue',
    )
    assert.equal(
      await refused(
        s.desktop.call(M.configWrite, {
          harness: 'dsh',
          edits: [{ key: 'no.such', value: 1 }],
          expectedVersion: written.version,
        }),
      ),
      'notFound',
    )
    // 密钥只写不读回，存在 dsh 的凭据文件里
    const second = await s.desktop.call(M.configRead, { harness: 'dsh' })
    assert.deepEqual(second.values['web-search-deepseek.apiKey'], { set: false })
    await s.desktop.call(M.configWrite, {
      harness: 'dsh',
      edits: [{ key: 'web-search-deepseek.apiKey', value: 'sk-fake-search' }],
      expectedVersion: second.version,
    })
    const third = await s.desktop.call(M.configRead, { harness: 'dsh' })
    assert.equal(third.values['agent-default-model.model'], other.value)
    assert.equal(third.values['permission.defaultPreset'], 'read-only')
    assert.equal(third.values['subagent.maxDepth'], 2)
    assert.deepEqual(third.values['web-search-deepseek.apiKey'], { set: true })
    assert.ok(!JSON.stringify(third).includes('sk-fake-search'), '读不回密钥')
    assert.match(
      await readFile(join(s.home, '.credentials.yaml'), 'utf8'),
      /LITCH_TEST_SEARCH_KEY: sk-fake-search/,
    )
    const patch = await readFile(s.patch, 'utf8')
    assert.match(patch, /id: agent-default-model/)
    assert.match(patch, /defaultPreset: read-only/)

    // 插件开关：立即生效
    const plugin = third.settings.find(
      (one: any) => one.key.startsWith('plugins.') && third.values[one.key] === false,
    )
    assert.ok(plugin, '前提：有关着的内置插件')
    await s.desktop.call(M.configWrite, {
      harness: 'dsh',
      edits: [{ key: plugin.key, value: true }],
      expectedVersion: third.version,
    })
    assert.equal((await s.desktop.call(M.configRead, { harness: 'dsh' })).values[plugin.key], true)

    // 官方桌面端那套 config/read 报的默认跟着原生设置走，写它也写进原生设置
    const { config } = await s.desktop.call('config/read', { cwd: s.cwd })
    assert.equal(config.model, other.value)
    assert.equal(config.default_permissions, ':read-only')
    assert.equal(config.sandbox_mode, 'read-only')
    const started = await s.desktop.call('thread/start', { cwd: s.cwd })
    assert.equal(started.model, other.value)
    await s.desktop.call('config/batchWrite', {
      edits: [{ keyPath: 'sandbox_mode', value: 'workspace-write', mergeStrategy: 'replace' }],
    })
    assert.equal(
      (await s.desktop.call(M.configRead, { harness: 'dsh' })).values['permission.defaultPreset'],
      'workspace-write',
    )

    const changed = s.desktop.notifications.filter(
      (one) => one.method === 'litch/harness/config/changed',
    )
    assert.ok(changed.length >= 3)
    assert.deepEqual(changed[0].params, { harness: 'dsh', part: 'config' })
    assert.equal(s.plain.notifications.filter((one) => one.method.startsWith('litch/')).length, 0)
  } finally {
    await dispose(s)
  }
})

test('HARNESS-DSH-007：dsh 离不开的内置插件开着时只读、不让关；被关掉了照样读得出来，能打开；别处有开关的插件不列', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    const read = await s.desktop.call(M.configRead, { harness: 'dsh' })
    const specOf = (from: any, key: string) => from.settings.find((one: any) => one.key === key)
    const session = specOf(read, 'plugins.include:session')
    assert.equal(read.values['plugins.include:session'], true)
    assert.equal(session.readOnly, true)
    assert.match(session.readOnlyReason['zh-CN'], /离不开/)
    assert.equal(
      await refused(
        s.desktop.call(M.configWrite, {
          harness: 'dsh',
          edits: [{ key: session.key, value: false }],
          expectedVersion: read.version,
        }),
      ),
      'readOnly',
    )
    // 关掉了也不碍事的照样能关
    const retry = specOf(read, 'plugins.include:llm-retry')
    assert.ok(retry && !retry.readOnly, '关掉不碍事的插件不是只读')
    // 会话日志上传、联网搜索在别的组里有开关：插件组里不列
    for (const id of ['session-log-deepseek', 'web-search-deepseek'])
      assert.equal(specOf(read, `plugins.include:${id}`), undefined, `插件组里不该有 ${id}`)

    // 以前的版本让人把权限预设插件关掉了：dsh 的权限预设没了，这一页照样读得出来，那个插件能打开
    const remote = await s.server.remote()
    const plugins = await remote.rpc('pluginManager/listPlugins', {})
    const permission = plugins.find((one: any) => one.patchId === 'permission')
    await remote
      .rpc('pluginManager/setPluginEnabled', { id: permission.entryId, enabled: false })
      .catch(() => {})
    const broken = await s.desktop.call(M.configRead, { harness: 'dsh' })
    const off = specOf(broken, 'plugins.include:permission')
    assert.equal(broken.values['plugins.include:permission'], false)
    assert.ok(!off.readOnly, '被关掉的离不开的插件可以打开')
    assert.match(off.description['zh-CN'], /请打开/)
    assert.equal(specOf(broken, 'permission.defaultPreset')?.options?.length ?? 0, 0)
    await s.desktop.call(M.configWrite, {
      harness: 'dsh',
      edits: [{ key: off.key, value: true }],
      expectedVersion: broken.version,
    })
    const fixed = await s.desktop.call(M.configRead, { harness: 'dsh' })
    assert.equal(fixed.values['plugins.include:permission'], true)
    assert.equal(specOf(fixed, 'plugins.include:permission').readOnly, true)
    assert.ok(specOf(fixed, 'permission.defaultPreset').options.length > 0, '权限预设回来了')
  } finally {
    await dispose(s)
  }
})

const providerOf = (read: any, id: string) => read.providers.find((one: any) => one.id === id)

test('HARNESS-DSH-003：provider：自带的填 key、登出，自定义网关的增改删和切换', {
  timeout: 180000,
}, async () => {
  const s = await scene()
  try {
    let read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(read.switchable, true)
    const official = providerOf(read, 'deepseek-official')
    // 测试环境里 DEEPSEEK_API_KEY 是环境变量：算登录了，但清不掉
    assert.deepEqual(
      [official.auth.signedIn, official.auth.kind, official.active],
      [true, 'env', true],
    )
    assert.equal(
      await refused(
        s.desktop.call(M.authLogout, { harness: 'dsh', providerId: 'deepseek-official' }),
      ),
      'readOnly',
    )
    assert.equal(providerOf(read, 'deepseek-account').methods[0].kind, 'oauthBrowser')
    const openrouter = providerOf(read, 'openrouter')
    assert.deepEqual([openrouter.kind, openrouter.auth.signedIn], ['builtin', false])

    // 自带的第三方填 key：照官方页写上 apiKeyEnv，key 进 dsh 的凭据
    const started = await s.desktop.call(M.authStart, {
      harness: 'dsh',
      providerId: 'openrouter',
      methodId: 'apiKey',
      inputs: { apiKey: 'sk-fake-openrouter' },
    })
    assert.equal(started.step.kind, 'done')
    assert.deepEqual([started.step.auth.signedIn, started.step.auth.kind], [true, 'apiKey'])
    assert.match(
      await readFile(join(s.home, '.credentials.yaml'), 'utf8'),
      /OPENROUTER_API_KEY: sk-fake-openrouter/,
    )
    assert.match(await readFile(s.patch, 'utf8'), /apiKeyEnv: OPENROUTER_API_KEY/)
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(providerOf(read, 'openrouter').canLogout, true)
    await s.desktop.call(M.authLogout, { harness: 'dsh', providerId: 'openrouter' })
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(providerOf(read, 'openrouter').auth.signedIn, false)

    // 自定义网关
    assert.equal(
      await refused(
        s.desktop.call(M.providersUpsert, {
          harness: 'dsh',
          providerId: '9bad',
          templateId: 'gateway',
          expectedVersion: read.version,
          definition: {
            baseURL: 'http://127.0.0.1:9/v1',
            api: 'openai-completions',
            models: ['m1'],
          },
        }),
      ),
      'invalidValue',
    )
    const upserted = await s.desktop.call(M.providersUpsert, {
      harness: 'dsh',
      providerId: 'my-gw',
      templateId: 'gateway',
      definition: {
        displayName: '我的网关',
        baseURL: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        models: ['m1', 'm2'],
        apiKey: 'sk-fake-gw',
      },
      expectedVersion: read.version,
    })
    assert.equal(upserted.restartRequired, false)
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    const gateway = providerOf(read, 'my-gw')
    assert.equal(gateway.kind, 'custom')
    assert.equal(gateway.templateId, 'gateway')
    assert.deepEqual(gateway.definition, {
      displayName: '我的网关',
      baseURL: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      models: ['m1', 'm2'],
      apiKey: { set: true },
    })
    assert.equal(gateway.auth.signedIn, true)
    // 改：模型少一个，key 不给就不动
    await s.desktop.call(M.providersUpsert, {
      harness: 'dsh',
      providerId: 'my-gw',
      templateId: 'gateway',
      expectedVersion: read.version,
      definition: {
        displayName: '我的网关',
        baseURL: 'http://127.0.0.1:9/v1',
        api: 'openai-completions',
        models: ['m2'],
      },
    })
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.deepEqual(providerOf(read, 'my-gw').definition.models, ['m2'])
    assert.deepEqual(providerOf(read, 'my-gw').definition.apiKey, { set: true })
    // 切换：默认模型换成这一家的
    await s.desktop.call(M.providersActivate, {
      harness: 'dsh',
      providerId: 'my-gw',
      expectedVersion: read.version,
    })
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(providerOf(read, 'my-gw').active, true)
    assert.equal(providerOf(read, 'deepseek-official').active, false)
    assert.equal((await s.desktop.call('config/read', { cwd: s.cwd })).config.model, 'my-gw/m2')
    await s.desktop.call(M.providersActivate, {
      harness: 'dsh',
      providerId: 'deepseek-official',
      expectedVersion: read.version,
    })
    // 删：定义和派生出来的凭据一起清掉
    await s.desktop.call(M.providersRemove, { harness: 'dsh', providerId: 'my-gw' })
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(providerOf(read, 'my-gw'), undefined)
    assert.doesNotMatch(await readFile(join(s.home, '.credentials.yaml'), 'utf8'), /MY_GW_API_KEY/)
    assert.equal(
      await refused(
        s.desktop.call(M.providersRemove, { harness: 'dsh', providerId: 'openrouter' }),
      ),
      'readOnly',
    )
  } finally {
    await dispose(s)
  }
})

/** 回环上的假 DeepSeek 平台：只答登录要用的那几个接口 */
async function fakePlatform(): Promise<{
  origin: string
  states: string[]
  close(): Promise<void>
}> {
  const states: string[] = []
  let origin = ''
  const server: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      let data: unknown = {}
      if (request.url?.endsWith('/auth_init')) {
        states.push(parsed.state)
        data = {
          authorize_url: `${origin}/dsh/authorize?id=a1`,
          authorize_id: 'a1',
          expires_in: 600,
        }
      } else if (request.url?.endsWith('/auth_exchange'))
        data = { token: 'litch-test-token', authorized_url: `${origin}/dsh/authorized` }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: data } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  return { origin, states, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

test('HARNESS-DSH-004：DeepSeek 账号登录给出授权链接和回调端口，浏览器回调后登录成功，可以登出', {
  timeout: 180000,
}, async () => {
  const platform = await fakePlatform()
  const s = await scene(
    `- id: deepseek-account\n  config:\n    platformOrigin: ${platform.origin}\n    allowLoopbackHttp: true\n`,
  )
  try {
    const started = await s.desktop.call(M.authStart, {
      harness: 'dsh',
      providerId: 'deepseek-account',
      methodId: 'browser',
    })
    assert.equal(started.step.kind, 'openUrl')
    assert.equal(started.step.url, `${platform.origin}/dsh/authorize?id=a1`)
    const port = started.step.callbackPort
    assert.ok(Number.isInteger(port) && port > 0)
    // 浏览器授权完回调到设备上 dsh 的 Web 入口
    const callback = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=c1&state=${encodeURIComponent(platform.states[0] as string)}`,
      {
        redirect: 'manual',
      },
    )
    assert.ok([200, 204, 302].includes(callback.status), `回调应被接受：${callback.status}`)
    const updated = await s.desktop.until(
      'litch/harness/auth/updated',
      (params) => params.step.kind === 'done',
    )
    assert.equal(updated.attemptId, started.attemptId)
    assert.equal(updated.providerId, 'deepseek-account')
    let read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.deepEqual(
      [
        providerOf(read, 'deepseek-account').auth.signedIn,
        providerOf(read, 'deepseek-account').auth.kind,
      ],
      [true, 'oauth'],
    )
    assert.equal(s.plain.notifications.filter((one) => one.method.startsWith('litch/')).length, 0)
    await s.desktop.call(M.authLogout, { harness: 'dsh', providerId: 'deepseek-account' })
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(providerOf(read, 'deepseek-account').auth.signedIn, false)

    // 开了再取消
    const again = await s.desktop.call(M.authStart, {
      harness: 'dsh',
      providerId: 'deepseek-account',
      methodId: 'browser',
    })
    assert.equal(again.step.kind, 'openUrl')
    await s.desktop.call(M.authCancel, { harness: 'dsh', attemptId: again.attemptId })
    read = await s.desktop.call(M.providersRead, { harness: 'dsh' })
    assert.equal(providerOf(read, 'deepseek-account').auth.signedIn, false)
  } finally {
    await dispose(s)
    await platform.close()
  }
})

test('HARNESS-DSH-005：MCP 改 profile 补丁文件里的插件行，注释、别的行和 !!js 表达式原样留着，密钥不回显', {
  timeout: 180000,
}, async () => {
  const prelude = [
    '# 用户自己的注释',
    '- insert:',
    '    - id: mcp-gh',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: gh',
    '        transport: stdio',
    '        command: /usr/bin/true',
    '        env:',
    '          GITHUB_TOKEN: !!js process.env.LITCH_TEST_GH',
    '',
  ].join('\n')
  const s = await scene(prelude)
  // 那条 !!js 表达式读的环境变量（dsh 是下面第一次调用时才起的，继承得到；收场时随隔离环境一起清掉）
  process.env.LITCH_TEST_GH = 'gh-from-env'
  try {
    let read = await s.desktop.call(M.mcpRead, { harness: 'dsh' })
    assert.deepEqual(read.transports, ['stdio', 'http'])
    assert.equal(read.files[0].path, s.patch)
    const gh = read.servers.find((one: any) => one.name === 'gh')
    assert.deepEqual(gh.env, { GITHUB_TOKEN: '!!js process.env.LITCH_TEST_GH' })
    assert.equal(gh.enabled, true)

    await s.desktop.call(M.mcpUpsert, {
      harness: 'dsh',
      server: {
        name: 'local',
        transport: 'stdio',
        enabled: true,
        command: '/usr/bin/true',
        args: ['--x'],
        env: { API_TOKEN: 'secret-1', MODE: 'dev' },
        extra: { toolCallTimeoutMs: 5000 },
      },
      expectedVersion: read.version,
    })
    read = await s.desktop.call(M.mcpRead, { harness: 'dsh' })
    let local = read.servers.find((one: any) => one.name === 'local')
    assert.deepEqual(local.env, { API_TOKEN: '', MODE: 'dev' })
    assert.deepEqual(local.secretKeys, ['API_TOKEN'])
    assert.deepEqual(local.extra, { toolCallTimeoutMs: 5000 })
    assert.ok(!JSON.stringify(read).includes('secret-1'))
    // 原样写回（密钥给空串）：密钥不变；停用写在行上
    await s.desktop.call(M.mcpUpsert, {
      harness: 'dsh',
      previousName: 'local',
      server: { ...local, enabled: false, env: { API_TOKEN: '', MODE: 'prod' } },
      expectedVersion: read.version,
    })
    // gh 原样写回：!!js 表达式不变
    read = await s.desktop.call(M.mcpRead, { harness: 'dsh' })
    await s.desktop.call(M.mcpUpsert, {
      harness: 'dsh',
      previousName: 'gh',
      server: read.servers.find((one: any) => one.name === 'gh'),
      expectedVersion: read.version,
    })
    let text = await readFile(s.patch, 'utf8')
    assert.match(text, /# 用户自己的注释/)
    assert.match(text, /GITHUB_TOKEN: !!js process\.env\.LITCH_TEST_GH/)
    assert.match(text, /API_TOKEN: secret-1/)
    assert.match(text, /MODE: prod/)
    assert.match(text, /disabled: true/)
    read = await s.desktop.call(M.mcpRead, { harness: 'dsh' })
    local = read.servers.find((one: any) => one.name === 'local')
    assert.deepEqual([local.enabled, local.status?.state], [false, 'disabled'])
    // dsh 自己认这一行（热重载之后插件清单里有它）
    for (let waited = 0; ; waited += 200) {
      const plugins = await (await s.server.remote()).rpc('pluginManager/listPlugins', {})
      if (plugins.some((one: any) => one.patchId === 'mcp-local')) break
      assert.ok(waited < 10000, 'dsh 应重载出 mcp-local')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    assert.equal(
      await refused(
        s.desktop.call(M.mcpUpsert, {
          harness: 'dsh',
          server: { name: 'x', transport: 'sse', enabled: true, url: 'http://a' },
          expectedVersion: read.version,
        }),
      ),
      'invalidValue',
    )
    assert.equal(
      await refused(
        s.desktop.call(M.mcpRemove, { harness: 'dsh', name: 'local', expectedVersion: 'stale' }),
      ),
      'versionConflict',
    )
    await s.desktop.call(M.mcpRemove, {
      harness: 'dsh',
      name: 'local',
      expectedVersion: read.version,
    })
    text = await readFile(s.patch, 'utf8')
    assert.doesNotMatch(text, /mcp-local/)
    assert.match(text, /mcp-gh/)
    assert.ok(
      s.desktop.notifications.some(
        (one) => one.method === 'litch/harness/config/changed' && one.params.part === 'mcp',
      ),
    )
  } finally {
    await dispose(s)
  }
})

test('HARNESS-DSH-006：指令文件是 $DSH_HOME/AGENTS.md，带哈希写，软链时写进它指向的那一份', async () => {
  const s = await scene()
  try {
    let read = await s.desktop.call(M.instructionsRead, { harness: 'dsh' })
    assert.deepEqual(
      [read.path, read.fileName, read.exists, read.hash, read.linkTarget],
      [join(s.home, 'AGENTS.md'), 'AGENTS.md', false, '', null],
    )
    const { hash } = await s.desktop.call(M.instructionsWrite, {
      harness: 'dsh',
      content: '# 规矩\n',
      expectedHash: '',
    })
    read = await s.desktop.call(M.instructionsRead, { harness: 'dsh' })
    assert.deepEqual([read.exists, read.content, read.hash], [true, '# 规矩\n', hash])
    assert.equal(
      await refused(
        s.desktop.call(M.instructionsWrite, { harness: 'dsh', content: 'x', expectedHash: '' }),
      ),
      'versionConflict',
    )
    // 统一模式下它是软链：写进源文件
    const source = join(s.root, 'shared-AGENTS.md')
    await writeFile(source, '共用\n')
    await rm(read.path)
    await symlink(source, read.path)
    read = await s.desktop.call(M.instructionsRead, { harness: 'dsh' })
    assert.equal(read.linkTarget, source)
    await s.desktop.call(M.instructionsWrite, {
      harness: 'dsh',
      content: '改过\n',
      expectedHash: read.hash,
    })
    assert.equal(await readFile(source, 'utf8'), '改过\n')
  } finally {
    await dispose(s)
  }
})
