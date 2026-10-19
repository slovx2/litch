import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { cliCommand } from '../../shared/src/host-cli.mjs'
import { dshVersionAtLeast, hostDshExecutable, hostDshVersion } from '../src/host-dsh.mjs'
import { RemoteError, WebRemote } from '../src/remote.mjs'
import { DshRuntime } from '../src/runtime.mjs'
import { versions } from '../src/versions.mjs'
import { assertResponse } from './schema.mjs'

test('版本下限与已验证版本与 protocol/versions.json 的登记一致', () => {
  const registered = JSON.parse(readFileSync(resolve('protocol/versions.json'), 'utf8'))
  assert.equal(versions.dshMinimum, registered.dshMinimum)
  assert.deepEqual([...versions.dshVerified], registered.dshVerified)
  assert.ok(
    versions.dshVerified.every((version) => dshVersionAtLeast(version, versions.dshMinimum)),
  )
})

test('runtime/info 的扩展 schema 接受 dsh 的预发布版本号，拒绝非法格式', () => {
  const info = {
    engine: 'dsh',
    protocolVersion: versions.protocol,
    nodeVersion: '24.14.0',
    cliBuild: '0.2.0-rc.2',
    capabilities: ['submission.idempotency'],
    releaseReady: false,
  }
  assertResponse('runtime/info', info)
  assertResponse('runtime/info', { ...info, cliBuild: '0.3.0' })
  for (const change of [
    { cliBuild: 'latest' },
    { nodeVersion: '24' },
    { sdkVersion: '0.2.0-rc.2' },
  ])
    assert.throws(() => assertResponse('runtime/info', { ...info, ...change }))
})

test('dsh 版本只设下限，下限可以落在预发布号上', () => {
  const minimum = '0.2.0-rc.2'
  for (const accepted of [
    '0.2.0-rc.2',
    '0.2.0-rc.3',
    '0.2.0-rc.10',
    '0.2.0',
    '0.2.1-alpha.2',
    '0.3.0',
    '1.0.0',
  ])
    assert.ok(dshVersionAtLeast(accepted, minimum), `应接受 ${accepted}`)
  for (const rejected of [
    '0.2.0-rc.1',
    '0.2.0-beta.9',
    '0.2.0-rc',
    '0.1.9',
    '0.2',
    'v0.2.0',
    '',
    undefined,
  ])
    assert.ok(!dshVersionAtLeast(rejected, minimum), `应拒绝 ${rejected}`)
  // 下限是稳定版时，同一核心版本的预发布版低于它。
  assert.ok(!dshVersionAtLeast('0.3.0-rc.1', '0.3.0'))
  assert.ok(dshVersionAtLeast('0.3.1-rc.1', '0.3.0'))
})

test('找不到 dsh 或版本过低时给出可操作的报错', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-adapter-dsh-cli-')))
  try {
    assert.throws(
      () => hostDshExecutable({ CHA_DSH_CLI: join(root, 'missing'), PATH: '' }),
      /宿主 dsh CLI 不可执行或未找到.*CHA_DSH_CLI/,
    )
    assert.throws(() => hostDshExecutable({ PATH: root }), /宿主 dsh CLI 不可执行或未找到: dsh/)
    const old = join(root, 'dsh')
    await writeFile(old, '#!/bin/sh\necho 0.1.5\n')
    await chmod(old, 0o755)
    assert.equal(hostDshExecutable({ PATH: root }), old, '默认从 PATH 查找')
    assert.throws(
      () => hostDshVersion(old, versions.dshMinimum),
      /宿主 dsh CLI 版本不符: 需要 >= 0\.2\.0-rc\.2，实际 0\.1\.5/,
    )
    const broken = join(root, 'broken')
    await writeFile(broken, '#!/bin/sh\nexit 3\n')
    await chmod(broken, 0o755)
    assert.throws(() => hostDshVersion(broken, versions.dshMinimum), /无法读取宿主 dsh CLI 版本/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 需要本机已安装 dsh：用 CHA_DSH_CLI 指定，或把 dsh 放进 PATH。不发模型请求。
test('接口与预期不符时报错带上当前与已验证的 dsh 版本；dsh 自己没办成的事带着它的原话，不说成接口不符', {
  timeout: 60000,
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-adapter-dsh-compat-')))
  const saved = { ...process.env }
  Object.assign(process.env, {
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/anthropic',
    DEEPSEEK_API_KEY: 'mock-not-a-real-key',
    DSH_AGENTS_HOME: join(root, 'agents-home'),
    DSH_HOME: join(root, 'home', 'dsh-home'),
  })
  const runtime = new DshRuntime(join(root, 'home'), {
    waterfall: async () => ({ kind: 'next' }),
    emit: () => {},
    closed: () => {},
  })
  try {
    const remote = await runtime.remote()
    assert.ok(runtime.host && dshVersionAtLeast(runtime.host.version, versions.dshMinimum))
    const hint = new RegExp(
      `当前 dsh ${runtime.host.version.replaceAll('.', '\\.')}，适配器验证过的版本：0\\.2\\.0-rc\\.2`,
    )
    const failure = async (work: Promise<unknown>) => {
      const error: any = await work.then(
        () => null,
        (reason) => reason,
      )
      assert.equal(error?.code, 'incompatible')
      assert.match(error.message, hint)
      return String(error.message)
    }
    // 方法不存在。
    assert.match(
      await failure(remote.rpc('session/doesNotExist', {})),
      /dsh 没有 session\/doesNotExist 这个方法/,
    )
    // 参数名对不上（新版本改了形参名时就是这种表现）。
    assert.match(
      await failure(remote.rpc('session/list', { request: {} })),
      /dsh 拒绝了 session\/list 调用（gateway\//,
    )
    // 返回值缺少适配器依赖的字段。
    assert.match(
      await failure(
        remote.rpc('session/list', { _request: {} }, (value) => Array.isArray(value?.sessions)),
      ),
      /session\/list 返回了适配器不认识的结构/,
    )
    // 流不存在。
    const ended = new Promise<Error | null>((resolve) =>
      remote.open('session/doesNotExist', {}, () => {}, resolve),
    )
    assert.match(
      await failure(ended.then((error) => Promise.reject(error))),
      /dsh 拒绝了 session\/doesNotExist 流/,
    )
    // 业务错误不算不兼容，原样透出。
    const missing: any = await remote
      .rpc('session/cancel', { request: { sessionId: 'no-such-session' } })
      .then(
        () => null,
        (reason) => reason,
      )
    if (missing) assert.notEqual(missing.code, 'incompatible')
    // dsh 自己没办成的事有的也用 gateway/ 开头的码，同样不是接口对不上：带着它的原话透出，不往版本上引。
    // 工作目录那个位置是个文件，会话建不出来（internal）；搜索词是空的，它不接受（bad-request）。
    await writeFile(join(root, 'a-file'), '')
    for (const [work, code, said] of [
      [
        () => remote.rpc('session/create', { request: { cwd: join(root, 'a-file') } }),
        'gateway/internal',
        /^session\/create: failed to create session .*EEXIST/,
      ],
      [
        () => remote.rpc('session/search', { request: { query: '' } }),
        'gateway/bad-request',
        /^session\/search: session search query must not be empty$/,
      ],
    ] as const) {
      const error: any = await work().then(
        () => null,
        (reason) => reason,
      )
      assert.equal(error?.code, code)
      assert.match(error.message, said)
      assert.doesNotMatch(error.message, /验证过的版本/)
    }
  } finally {
    await runtime.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await rm(root, { recursive: true, force: true })
  }
})

// 高于下限但未验证过的版本：照常放行，只在日志里提示一次；出问题时报错里是这个版本号。
test('未验证的新版本 dsh 放行并提示', { timeout: 60000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-harness-adapter-dsh-newer-')))
  const saved = { ...process.env }
  const wrapper = join(root, 'dsh')
  const real = cliCommand(hostDshExecutable(), [])
    .map((part) => `'${part.replaceAll("'", `'\\''`)}'`)
    .join(' ')
  await writeFile(
    wrapper,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9-alpha.1; exit 0; fi\nexec ${real} "$@"\n`,
  )
  await chmod(wrapper, 0o755)
  Object.assign(process.env, {
    CHA_DSH_CLI: wrapper,
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/anthropic',
    DEEPSEEK_API_KEY: 'mock-not-a-real-key',
    DSH_AGENTS_HOME: join(root, 'agents-home'),
    DSH_HOME: join(root, 'home', 'dsh-home'),
  })
  const logged: string[] = []
  const original = console.error
  console.error = (...parts: unknown[]) => {
    logged.push(parts.join(' '))
  }
  const runtime = new DshRuntime(join(root, 'home'), {
    waterfall: async () => ({ kind: 'next' }),
    emit: () => {},
    closed: () => {},
  })
  try {
    const remote = await runtime.remote()
    assert.deepEqual(
      { version: runtime.host?.version, verified: runtime.host?.verified },
      { version: '9.9.9-alpha.1', verified: false },
    )
    assert.ok(logged.some((line) => /尚未验证.*当前 dsh 9\.9\.9-alpha\.1/.test(line)))
    assert.ok(Array.isArray((await remote.rpc('session/list', { _request: {} })).items))
    const error: any = await remote.rpc('session/doesNotExist', {}).catch((reason) => reason)
    assert.match(error.message, /当前 dsh 9\.9\.9-alpha\.1，适配器验证过的版本：0\.2\.0-rc\.2/)
  } finally {
    console.error = original
    await runtime.close()
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    await rm(root, { recursive: true, force: true })
  }
})

test('连不上 dsh 时报错里带着连接层的原因，不是只有一句 fetch failed', async () => {
  // 占一个端口再放掉：这个端口上现在没有人在听
  const holder = createServer()
  await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done))
  const port = (holder.address() as { port: number }).port
  await new Promise<void>((done) => holder.close(() => done()))
  await assert.rejects(
    WebRemote.connect(`http://127.0.0.1:${port}/?launch=x`, '0.2.0-rc.2', {
      waterfall: async () => ({ kind: 'next' }),
      emit: () => {},
      closed: () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof RemoteError)
      assert.equal(error.code, 'network')
      assert.match(error.message, /ECONNREFUSED/)
      assert.doesNotMatch(error.message, /^fetch failed$/)
      return true
    },
  )
})
