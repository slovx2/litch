// 给设备装 harness（harnessInstall 扩展，protocol/extensions/harness-install.json）在设备进程这一侧：
// 有主进程在管时 runtime/info 才列这项扩展；三个方法经控制通道转过去，错误照 deviceSettings 那一套翻；
// 安装进度只转给握手时声明了 harnessInstall 的连接。后半段对着真的主进程（Go，现编出来）走一遍：
// 假的 npm 和注册表在临时目录里，装上一个假的 dsh，看它被启用、起来，应答和通知都按扩展定义校验。
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Ajv } from 'ajv'
import { FakeControl, failure, managed } from './fake-control.mjs'
import { FakeUpstream } from './fake-upstream.mjs'
import { REPO, rig, settingsErrorCode, settle, TestClient, tempDir } from './helpers.mjs'

const VERSIONS = 'litch/device/harness/versions'
const INSTALL = 'litch/device/harness/install'
const READ = 'litch/device/harness/install/read'
const CHANGED = 'litch/device/harness/install/changed'

const definition = JSON.parse(
  readFileSync(join(REPO, 'protocol/extensions/harness-install.json'), 'utf8'),
)
const ajv = new Ajv({ strict: false, allErrors: true })

function part(kind: string, method?: string): any {
  const found = definition.parts.find(
    (item: any) => item.kind === kind && (method === undefined || item.method === method),
  )
  if (!found) throw new Error(`扩展定义里没有 ${kind} ${method ?? ''}`)
  return found
}

function check(schema: unknown, value: unknown, what: string): void {
  const validate = ajv.compile({ ...(schema as object), definitions: definition.definitions })
  if (!validate(value))
    throw new Error(`${what} 和扩展定义对不上：${JSON.stringify(validate.errors)}`)
}

const response = (method: string, value: unknown) =>
  check(part('ClientRequest', method).response, value, `${method} 的应答`)
const params = (method: string, value: unknown) =>
  check(part('ClientRequest', method).params, value, `${method} 的参数`)
const notice = (value: unknown) =>
  check(part('ServerNotification', CHANGED).params, value, '安装进度的通知')
const errorData = (value: unknown) => check(part('Error').data, value, 'error.data')
const installErrorCode = (reason: string): number =>
  part('Error').errors.find((item: any) => item.litch === reason).code

const JOB = {
  job: 'install-1-1',
  harness: 'pi',
  version: 'verified',
  resolved: '0.99.1',
  state: 'running',
  command: 'npm install -g @earendil-works/pi-coding-agent@0.99.1',
  log: ['added 1 package'],
  startedAt: 1,
  endedAt: null,
}

function setup() {
  const fakes = { pi: new FakeUpstream('pi') }
  const control = new FakeControl([managed('pi')])
  const device = rig(
    {},
    {},
    { control, dial: (socket) => fakes[socket.slice('fake://'.length) as 'pi'].connector },
  )
  return { ...device, control }
}

test('有主进程在管时 runtime/info 列 harnessInstall；没有时不列，方法回 settingsUnavailable', async () => {
  const managedDevice = setup()
  const bare = rig({ pi: new FakeUpstream('pi') })
  try {
    const client = managedDevice.connect()
    await client.initialize(['harness'])
    assert.ok((await client.call('runtime/info')).device.extensions.includes('harnessInstall'))
    const plain = bare.connect()
    await plain.initialize(['harness'])
    assert.ok(!(await plain.call('runtime/info')).device.extensions.includes('harnessInstall'))
    const refused = await plain.fails(VERSIONS, {})
    assert.equal(refused.code, settingsErrorCode('settingsUnavailable'))
    assert.equal(refused.code, installErrorCode('settingsUnavailable'))
    errorData(refused.data)
    // 要先握手
    const early = managedDevice.connect()
    assert.equal((await early.fails(VERSIONS, {})).message, 'Not initialized')
  } finally {
    await managedDevice.close()
    await bare.close()
  }
})

test('三个方法转给主进程，应答原样交回；正在装别的、参数不对、不能装各回各的错误', async () => {
  const { connect, control, close } = setup()
  const info = {
    harness: 'pi',
    installable: true,
    method: 'npm',
    installed: null,
    minimum: '0.99.1',
    verified: '0.99.1',
    latest: '0.100.0',
    docsUrl: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    manual: 'npm install -g @earendil-works/pi-coding-agent@0.99.1',
  }
  control.handlers['harness.versions'] = () => ({ harnesses: [info] })
  control.handlers['harness.install'] = (request) => {
    if (request.harness === 'dsh')
      throw failure({
        reason: 'busy',
        harness: 'pi',
        text: { 'zh-CN': '这台设备正在装 Pi', en: 'This device is installing Pi' },
      })
    if (request.harness === 'acp') throw failure({ reason: 'failed', harness: 'acp' })
    if (request.version !== 'verified' && request.version !== 'latest')
      throw failure({ reason: 'invalid' })
    return { job: JOB.job }
  }
  control.handlers['harness.install.read'] = () => ({ jobs: [JOB] })
  try {
    const client = connect()
    await client.initialize(['harness'])
    params(VERSIONS, { latest: true })
    const versions = await client.call(VERSIONS, { latest: true })
    response(VERSIONS, versions)
    assert.deepEqual(versions.harnesses, [info])
    await client.call(VERSIONS)
    params(INSTALL, { harness: 'pi', version: 'verified' })
    const started = await client.call(INSTALL, { harness: 'pi', version: 'verified' })
    response(INSTALL, started)
    const read = await client.call(READ, {})
    response(READ, read)
    assert.deepEqual(
      control.requests
        .filter((request) => request.method.startsWith('harness.'))
        .map((request) => [request.method, request.params]),
      [
        ['harness.versions', { latest: true }],
        ['harness.versions', { latest: false }],
        ['harness.install', { harness: 'pi', version: 'verified' }],
        ['harness.install.read', {}],
      ],
    )
    const busy = await client.fails(INSTALL, { harness: 'dsh', version: 'verified' })
    assert.equal(busy.code, installErrorCode('harnessBusy'))
    assert.deepEqual([busy.data.litch, busy.data.harness], ['harnessBusy', 'pi'])
    errorData(busy.data)
    const invalid = await client.fails(INSTALL, { harness: 'pi', version: 'newest' })
    assert.equal(invalid.code, installErrorCode('invalidSetting'))
    errorData(invalid.data)
    const refused = await client.fails(INSTALL, { harness: 'acp', version: 'latest' })
    assert.equal(refused.code, installErrorCode('deviceActionFailed'))
    errorData(refused.data)
  } finally {
    await close()
  }
})

test('安装进度只转给声明了 harnessInstall 的连接', async () => {
  const { connect, control, close } = setup()
  try {
    const declared = connect()
    await declared.initialize(['harness', 'harnessInstall'])
    const plain = connect()
    await plain.initialize(['harness', 'deviceSettings'])
    notice(JOB)
    control.onInstall?.(JOB)
    const done = { ...JOB, state: 'succeeded', endedAt: 2, installed: '0.99.1' }
    notice(done)
    control.onInstall?.(done)
    const last = await declared.waitFor(
      (frame) => frame.method === CHANGED && (frame.params as any).state === 'succeeded',
    )
    assert.deepEqual(last.params, done)
    assert.deepEqual(
      declared.notifications
        .filter((frame) => frame.method === CHANGED)
        .map((frame) => (frame.params as any).state),
      ['running', 'succeeded'],
    )
    await settle(50)
    assert.ok(!plain.notifications.some((frame) => frame.method === CHANGED))
  } finally {
    await close()
  }
})

// ---------- 对着真的主进程 ----------

/** 编译出来的测试所在的目录（dist/device/test），假运行时就在这里 */
const HERE = dirname(fileURLToPath(import.meta.url))

interface Service {
  child: ChildProcess
  root: string
  socket: string
  bin: string
  output(): string
  stop(): Promise<void>
}

async function until<T>(attempt: () => T | undefined, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = attempt()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒没有等到：${what}`)
    await settle(50)
  }
}

/** 起真的主进程：运行时是假的，PATH 里有假的 npm；装到 bin 里的 dsh 也是 PATH 上的 */
function startService(registry: string): Promise<Service> {
  const root = tempDir()
  const binary = join(root, 'cha')
  const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  assert.equal(built.status, 0, `适配器主进程没有编出来：\n${built.stderr}`)
  const stage = join(root, 'r')
  const entry = (name: string, source: string) => {
    const path = join(stage, 'packages', name, 'dist', name, 'src', `${source}.mjs`)
    mkdirSync(dirname(path), { recursive: true })
    return path
  }
  const fake = pathToFileURL(join(HERE, 'fake-runtime.mjs')).href
  for (const [name, engine] of [
    ['claude', 'claude-code'],
    ['pi', 'pi'],
    ['dsh', 'dsh'],
  ] as const)
    writeFileSync(
      entry(name, 'adapter'),
      `import { run } from ${JSON.stringify(fake)}\nrun(${JSON.stringify(engine)})\n`,
    )
  writeFileSync(
    entry('device', 'main'),
    `import ${JSON.stringify(pathToFileURL(join(HERE, '../src/main.mjs')).href)}\n`,
  )
  const tools = join(root, 'tools')
  const bin = join(root, 'bin')
  const userHome = join(root, 'u')
  for (const dir of [tools, bin, userHome]) mkdirSync(dir, { recursive: true })
  // 假的 npm：打两行，把一个 --version 打 0.2.0-rc.2 的 dsh 放进 bin
  writeFileSync(
    join(tools, 'npm'),
    `#!/bin/sh\necho "npm $*"\necho "added 1 package"\nprintf '#!/bin/sh\\necho "dsh 0.2.0-rc.2"\\n' > '${bin}/dsh'\nchmod +x '${bin}/dsh'\n`,
  )
  chmodSync(join(tools, 'npm'), 0o755)
  const home = join(root, 'h')
  const child = spawn(
    binary,
    ['start', ...['--home', home, '--root', stage, '--node', process.execPath], '--ssh=off'],
    {
      env: {
        PATH: `${tools}:${bin}:/usr/bin:/bin`,
        HOME: userHome,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        CHA_LANG: 'zh-CN',
        LITCH_NPM_REGISTRY: registry,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout?.on('data', (data) => {
    output += data
  })
  child.stderr?.on('data', (data) => {
    output += data
  })
  const socket = join(home, 'device', 'device.sock')
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
      await exited
      clearTimeout(timer)
    }
    rmSync(root, { recursive: true, force: true })
  }
  return until(() => {
    if (child.exitCode !== null) throw new Error(`适配器主进程提前退出了：\n${output}`)
    return existsSync(socket) ? true : undefined
  }, '聚合面的套接字').then(
    () => ({ child, root, socket, bin, output: () => output, stop }),
    async (error) => {
      await stop()
      throw new Error(`${error instanceof Error ? error.message : error}\n${output}`)
    },
  )
}

function registry(): Promise<{ server: Server; url: string; asked: string[] }> {
  const asked: string[] = []
  const server = createServer((request, reply) => {
    asked.push(request.url ?? '')
    if (request.url === '/@deepseek-ai/dsh/latest') {
      reply.setHeader('content-type', 'application/json')
      reply.end(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.3.0' }))
      return
    }
    reply.statusCode = 404
    reply.end('{}')
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        asked,
      }),
    ),
  )
}

test('真的主进程：查版本、装上 dsh（假 npm），它被启用并起来；应答和通知都按扩展定义', {
  timeout: 240_000,
}, async (t) => {
  if (process.platform === 'win32' || spawnSync('go', ['version']).status !== 0) {
    t.skip('要 go 和类 Unix 的 shell')
    return
  }
  const fakeRegistry = await registry()
  const service = await startService(fakeRegistry.url)
  try {
    let declared: TestClient | null = null
    for (const deadline = Date.now() + 30_000; !declared; ) {
      declared = await TestClient.overSocket(service.socket).catch(() => null)
      if (!declared && Date.now() > deadline) throw new Error('聚合面连不上')
      if (!declared) await settle(100)
    }
    await declared.initialize(['harness', 'deviceSettings', 'harnessInstall'])
    const plain = await TestClient.overSocket(service.socket)
    await plain.initialize(['harness', 'deviceSettings'])
    const info = await declared.call('runtime/info')
    assert.ok(info.device.extensions.includes('harnessInstall'))
    const dshBefore = info.harnesses.find((item: any) => item.id === 'dsh')
    assert.equal(dshBefore.unavailable?.kind, 'notInstalled')

    const versions = await declared.call(VERSIONS, { latest: true })
    response(VERSIONS, versions)
    const ids = versions.harnesses.map((item: any) => item.harness)
    assert.deepEqual(
      ids,
      info.harnesses.map((item: any) => item.id),
    )
    const dsh = versions.harnesses.find((item: any) => item.harness === 'dsh')
    assert.equal(dsh.installed, null)
    assert.equal(dsh.latest, '0.3.0')
    assert.equal(dsh.minimum, '0.2.0-rc.2')
    assert.equal(dsh.manual, `npm install -g @deepseek-ai/dsh@${dsh.verified}`)
    const acp = versions.harnesses.find((item: any) => item.harness === 'acp')
    assert.deepEqual([acp.installable, acp.method, acp.manual], [false, null, ''])
    // 别的包在假注册表上查不到：各自带着原因，不挡别的
    assert.ok(versions.harnesses.find((item: any) => item.harness === 'pi').latestError.en)

    const started = await declared.call(INSTALL, { harness: 'dsh', version: 'verified' })
    response(INSTALL, started)
    const done = await declared.waitFor(
      (frame) =>
        frame.method === CHANGED &&
        (frame.params as any).job === started.job &&
        (frame.params as any).state !== 'running',
      120_000,
    )
    const notices = declared.notifications.filter((frame) => frame.method === CHANGED)
    for (const frame of notices) notice(frame.params)
    const job = done.params as any
    assert.equal(job.state, 'succeeded', JSON.stringify(job))
    assert.equal(job.installed, '0.2.0-rc.2')
    assert.ok(job.log.includes('added 1 package'))
    assert.ok(job.log.some((line: string) => line.startsWith('[litch]')))
    // 装了才启用的 dsh：装上以后重新应用，它起来了
    await declared.waitFor(
      (frame) =>
        frame.method === 'litch/harness/status/changed' &&
        (frame.params as any).harness === 'dsh' &&
        (frame.params as any).info.available === true,
      60_000,
    )
    const read = await declared.call(READ, {})
    response(READ, read)
    assert.deepEqual(
      read.jobs.map((item: any) => [item.job, item.state]),
      [[started.job, 'succeeded']],
    )
    const after = await declared.call(VERSIONS, {})
    response(VERSIONS, after)
    const dshAfter = after.harnesses.find((item: any) => item.harness === 'dsh')
    assert.deepEqual([dshAfter.installed, dshAfter.latest], ['0.2.0-rc.2', '0.3.0'])
    assert.ok(!plain.notifications.some((frame) => frame.method === CHANGED))
    assert.ok(fakeRegistry.asked.includes('/@deepseek-ai/dsh/latest'))
    declared.close()
    plain.close()
  } finally {
    await service.stop()
    fakeRegistry.server.close()
  }
})
