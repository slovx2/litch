// 端到端：真的适配器主进程（Go，现编出来）拉起真的设备进程（刚构建的这一份）和假的运行时进程
// （fake-runtime.mts，顶在 Claude Code 和 Pi 的位置上），客户端只连聚合面这一条，
// 把设备配置接口从头走一遍：读设置、写设置、停用和启用、重启、诊断、日志、ssh 配置片段。
// 状态目录、用户主目录都在临时目录里，SSH 入口用系统分配的空闲端口，不碰任何真的 harness。
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_PROCESS_LIMITS } from '../src/device-processes.mjs'
import {
  assertRuntimeInfo,
  assertSettingsChanged,
  assertSettingsErrorData,
  assertSettingsResponse,
  assertStatusChanged,
  assertThreadList,
  REPO,
  settingsErrorCode,
  settle,
  TestClient,
  tempDir,
} from './helpers.mjs'

const STATUS = 'litch/harness/status/changed'
const CHANGED = 'litch/device/settings/changed'
const READ = 'litch/device/settings/read'
const WRITE = 'litch/device/settings/write'
const RESTART = 'litch/device/harness/restart'
const SECRET = 'TOP-SECRET-VALUE'
// 2026-10-17 加的四个 harness 在这里的默认状况：隔离的 HOME 里没有 opencode，三个 ACP 入口默认停用
const NEW_HARNESSES: [string, string][] = [
  ['opencode', 'notInstalled'],
  ['gemini', 'disabled'],
  ['qwen', 'disabled'],
  ['acp', 'disabled'],
]
/** 这里起不来的入口，给不出 ssh 配置片段 */
const NOT_RUNNING = ['dsh', ...NEW_HARNESSES.map(([id]) => id)]

/** 编译出来的测试所在的目录（dist/device/test），假运行时就在这里 */
const HERE = dirname(fileURLToPath(import.meta.url))

function freePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => net.createServer())
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<number>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
        }),
    ),
  ).finally(() => Promise.all(servers.map((server) => new Promise((done) => server.close(done)))))
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until<T>(
  attempt: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await attempt()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒没有等到：${what}`)
    await settle(50)
  }
}

interface Service {
  child: ChildProcess
  home: string
  socket: string
  ports: { claude: number; pi: number }
  /** 主进程打到终端上的字 */
  output(): string
  stop(): Promise<void>
}

/** extraEnv：主进程环境里多带的变量（比如把某个 harness 的命令行指到不存在的地方） */
async function startService(extraEnv: Record<string, string> = {}): Promise<Service> {
  const root = tempDir()
  try {
    const binary = join(root, 'cha')
    const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
      cwd: REPO,
      encoding: 'utf8',
    })
    assert.equal(built.status, 0, `适配器主进程没有编出来：\n${built.stderr}`)
    // 主进程按 <root>/packages/<名字>/dist/… 找运行时和设备进程：运行时的位置上放假的，设备进程用真的
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
    ])
      writeFileSync(
        entry(name as string, 'adapter'),
        `import { run } from ${JSON.stringify(fake)}\nrun(${JSON.stringify(engine)})\n`,
      )
    writeFileSync(
      entry('device', 'main'),
      `import ${JSON.stringify(pathToFileURL(join(HERE, '../src/main.mjs')).href)}\n`,
    )
    const home = join(root, 'h')
    const userHome = join(root, 'u')
    mkdirSync(userHome)
    const [claude, pi, dsh] = (await freePorts(3)) as [number, number, number]
    const child = spawn(
      binary,
      [
        'start',
        ...['--home', home, '--root', stage, '--node', process.execPath],
        ...['--claude-port', String(claude), '--pi-port', String(pi), '--dsh-port', String(dsh)],
      ],
      {
        // 干净的环境：不带个人的任何凭据和配置；PATH 里没有 dsh，它算没装
        env: {
          PATH: '/usr/bin:/bin',
          HOME: userHome,
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          CHA_LANG: 'zh-CN',
          ...extraEnv,
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
    try {
      await until(
        () => {
          if (child.exitCode !== null) throw new Error(`适配器主进程提前退出了：\n${output}`)
          return existsSync(socket) ? true : undefined
        },
        '聚合面的套接字',
        60_000,
      )
    } catch (error) {
      await stop()
      throw new Error(`${error instanceof Error ? error.message : error}\n${output}`)
    }
    return { child, home, socket, ports: { claude, pi }, output: () => output, stop }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** 假运行时那个进程的某个环境变量和进程号。那个 harness 还没起来时接着等 */
function runtimeEnv(
  client: TestClient,
  harness: string,
  name: string,
): Promise<{ value: string | null; pid: number }> {
  return until(
    () => client.call('fixture/env', { harness, name }).catch(() => undefined),
    `${harness} 可用`,
  )
}

const statusOf =
  (harness: string, kind: string | null) =>
  (frame: { method?: string; params?: unknown }): boolean => {
    const params = frame.params as any
    return (
      frame.method === STATUS &&
      params.harness === harness &&
      (params.info.unavailable?.kind ?? null) === kind
    )
  }

test('真的主进程加真的设备进程加假的运行时：一条聚合面连接走完设备配置接口', {
  timeout: 240_000,
}, async (t) => {
  if (spawnSync('go', ['version']).status !== 0) {
    t.skip('这台机器上没有 go，编不出适配器主进程')
    return
  }
  const service = await startService()
  let client: TestClient | null = null
  const pids = new Set<number>()
  try {
    client = await until(
      () => TestClient.overSocket(service.socket).catch(() => undefined),
      '聚合面能连',
    )
    await client.initialize(['harness', 'deviceSettings'])
    const call = (method: string, params?: unknown) => (client as TestClient).call(method, params)
    /** 从第几条通知起，这条连接收到的设置变化通知 */
    const settingsNotices = (from: number): any[] =>
      (client as TestClient).notifications
        .slice(from)
        .filter((frame) => frame.method === CHANGED)
        .map((frame) => frame.params)
    /** 快照里每个 SSH 入口的状况 */
    const entryStates = (snapshot: any): Record<string, string> =>
      Object.fromEntries(snapshot.sshEntries.map((item: any) => [item.harness, item.state]))
    /** 从现在起收到的通知里找 */
    const next = (predicate: (frame: any) => boolean, timeoutMs = 30_000) => {
      const from = (client as TestClient).notifications.length
      return (client as TestClient).waitFor(
        (frame) => (client as TestClient).notifications.indexOf(frame) >= from && predicate(frame),
        timeoutMs,
      )
    }

    await t.test('runtime/info：三个已知的 harness 都在，没装的说明原因', async () => {
      const info = await call('runtime/info')
      // 真的主进程给的原因带着两种语言的说明，整份应答和 harness 扩展的定义对得上
      assertRuntimeInfo(info)
      assert.ok(info.device.extensions.includes('deviceSettings'))
      assert.deepEqual(
        info.harnesses.map((item: any) => [item.id, item.unavailable?.kind ?? null]),
        [
          ['claude-code', null],
          ['pi', null],
          ['dsh', 'notInstalled'],
          // 原生 codex 装了才默认启用，这里的 PATH 里没有它（它的端到端用例在 service-codex.test.mts）
          ...NEW_HARNESSES,
          ['codex', 'notInstalled'],
        ],
      )
      const dsh = info.harnesses[2].unavailable
      assert.ok(dsh.text['zh-CN'] && dsh.text.en, '两种语言的说明都有')
      assert.equal(dsh.message, dsh.text['zh-CN'])
      // 只声明了 harness 的客户端看到的还是原来的形状
      const plain = await TestClient.overSocket(service.socket)
      await plain.initialize()
      const seen = await plain.call('runtime/info')
      assertRuntimeInfo(seen)
      assert.equal(seen.harnesses[2].unavailable.text, undefined)
      plain.close()
    })

    await t.test('读设置：结构、当前值、版本号、SSH 入口的状况', async () => {
      // SSH 入口排在聚合面后面起，等它们都听上
      const read = await until(async () => {
        const current = await call(READ)
        const up = current.snapshot.sshEntries.filter((item: any) => item.state === 'listening')
        return up.length === 2 ? current : undefined
      }, '两个 SSH 入口都在听')
      assertSettingsResponse(READ, read)
      assert.equal(read.snapshot.version, 0)
      assert.deepEqual(read.snapshot.explicit, [])
      assert.deepEqual(read.snapshot.pendingRestart, [])
      assert.equal(read.snapshot.values['harness.pi.enabled'], true)
      assert.equal(read.snapshot.values['harness.dsh.enabled'], false, '没装的 dsh 默认不启用')
      assert.equal(read.snapshot.values['ssh.claude-code.port'], service.ports.claude)
      assert.equal(read.snapshot.values['ssh.pi.port'], service.ports.pi)
      assert.deepEqual(read.snapshot.values['harness.pi.env'], [])
      const keys = read.schema.settings.map((item: any) => item.key)
      for (const key of ['harness.claude-code.cliPath', 'harness.pi.env', 'ssh.pi.enabled'])
        assert.ok(keys.includes(key), `结构里有 ${key}`)
      const env = read.schema.settings.find((item: any) => item.key === 'harness.pi.env')
      assert.deepEqual(
        [env.type, env.scope, env.restart],
        ['env', { kind: 'harness', harness: 'pi' }, 'harness'],
      )
      assert.ok(env.title['zh-CN'] && env.title.en && env.description.en)
      // 设置里每个 harness 那一组的标题就是 runtime/info 里它的显示名：主进程和设备进程读的是同一个文件。
      // 这里连着的、没装的、停用的都有，没连上过的那两个用的是登记的名字
      const named = (await call('runtime/info')).harnesses
      for (const harness of named) {
        const group = read.schema.groups.find((item: any) => item.id === `harness.${harness.id}`)
        assert.deepEqual(
          group.title,
          { 'zh-CN': harness.displayName, en: harness.displayName },
          `${harness.id} 那一组的标题和它的显示名一样`,
        )
      }
      assert.deepEqual(
        named.map((item: any) => [item.displayName, item.badge]),
        [
          ['Claude Code', 'CC'],
          ['Pi', 'PI'],
          ['DSH', 'DS'],
          ['OpenCode', 'OC'],
          ['Gemini CLI', 'GE'],
          ['Qwen Code', 'QW'],
          ['ACP', 'AC'],
          ['Codex', 'CX'],
        ],
      )
    })

    await t.test('写入被拒：版本号对不上，值不合规矩', async () => {
      const stale = await (client as TestClient).fails(WRITE, {
        expectedVersion: 5,
        edits: [{ key: 'harness.pi.enabled', value: false }],
      })
      assert.equal(stale.code, settingsErrorCode('settingsConflict'))
      assert.equal(stale.data.snapshot.version, 0)
      assertSettingsErrorData(stale.data)
      const invalid = await (client as TestClient).fails(WRITE, {
        expectedVersion: 0,
        edits: [{ key: 'ssh.pi.port', value: 70000 }],
      })
      assert.equal(invalid.code, settingsErrorCode('invalidSetting'))
      assert.equal(invalid.data.key, 'ssh.pi.port')
      assertSettingsErrorData(invalid.data)
      assert.equal((await call(READ)).snapshot.version, 0, '被拒的写入什么都没改')
    })

    await t.test('改环境变量：没有回合在跑的现在就重启生效；密钥读回只知道设了', async () => {
      const before = await runtimeEnv(client as TestClient, 'pi', 'FIXTURE_MARK')
      assert.equal(before.value, null)
      pids.add(before.pid)
      const from = (client as TestClient).notifications.length
      const written = await call(WRITE, {
        expectedVersion: 0,
        edits: [
          {
            key: 'harness.pi.env',
            value: [
              { name: 'FIXTURE_MARK', value: 'one' },
              { name: 'FIXTURE_CREDENTIAL', value: SECRET, secret: true },
            ],
          },
        ],
      })
      assertSettingsResponse(WRITE, written)
      assert.deepEqual(written.changed, ['harness.pi.env'])
      assert.deepEqual(written.restarted, ['pi'])
      assert.deepEqual(written.snapshot.pendingRestart, [])
      assert.equal(written.snapshot.version, 1)
      // 应答就是定下来的样子：Pi 已经照新设置起来了，它的 SSH 入口也重新听上了
      assert.deepEqual(entryStates(written.snapshot), {
        'claude-code': 'listening',
        pi: 'listening',
        dsh: 'idle',
        opencode: 'idle',
        gemini: 'idle',
        qwen: 'idle',
        acp: 'idle',
      })
      assert.equal(alive(before.pid), false, '原来的运行时进程停掉了')
      const after = await runtimeEnv(client as TestClient, 'pi', 'FIXTURE_MARK')
      assert.notEqual(after.pid, before.pid, '应答到的时候运行时已经换了一个进程')
      pids.add(after.pid)
      assert.equal(after.value, 'one')
      // 途中的样子（先标成待重启、入口没了又回来）没有发出来：只在应答之前发了一条，和应答里的是同一份；
      // 之后也没有再补一条
      await settle(500)
      const notices = settingsNotices(from)
      assert.equal(notices.length, 1)
      assertSettingsChanged(notices[0])
      assert.deepEqual(notices[0], { keys: ['harness.pi.env'], snapshot: written.snapshot })
      // 密钥进了运行时的环境。只比摘要，密钥本身不经线上传回来
      const credential = await call('fixture/env', {
        harness: 'pi',
        name: 'FIXTURE_CREDENTIAL',
        digest: true,
      })
      assert.equal(credential.value, createHash('sha256').update(SECRET).digest('hex'))

      // 读回来：普通变量有值，密钥只有名字
      const read = await call(READ)
      assertSettingsResponse(READ, read)
      assert.deepEqual(read.snapshot.values['harness.pi.env'], [
        { name: 'FIXTURE_MARK', value: 'one' },
        { name: 'FIXTURE_CREDENTIAL', secret: true },
      ])
      assert.deepEqual(read.snapshot.explicit, ['harness.pi.env'])
      // 设置落在设备服务的状态目录里，只有属主能读写
      const file = join(service.home, 'device', 'settings.json')
      assert.equal(statSync(file).mode & 0o777, 0o600)
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
    })

    await t.test('有回合在跑：写入成功但留着待重启；明说照做才重启', async () => {
      const before = await runtimeEnv(client as TestClient, 'claude-code', 'FIXTURE_MARK')
      pids.add(before.pid)
      const busy = join(service.home, 'claude-code', 'busy')
      writeFileSync(busy, '')
      const from = (client as TestClient).notifications.length
      const held = await call(WRITE, {
        expectedVersion: 1,
        edits: [
          { key: 'harness.claude-code.env', value: [{ name: 'FIXTURE_MARK', value: 'two' }] },
        ],
      })
      assert.deepEqual(held.restarted, [])
      assert.deepEqual(held.snapshot.pendingRestart, ['claude-code'])
      const same = await runtimeEnv(client as TestClient, 'claude-code', 'FIXTURE_MARK')
      assert.deepEqual(same, before, '运行时没有被打断')
      // 真的要等回合结束的待重启照旧留着，通知也只有一条
      await settle(300)
      assert.deepEqual(settingsNotices(from), [
        { keys: ['harness.claude-code.env'], snapshot: held.snapshot },
      ])

      const refused = await (client as TestClient).fails(RESTART, { harness: 'claude-code' })
      assert.equal(refused.code, settingsErrorCode('harnessBusy'))
      assertSettingsErrorData(refused.data)

      const forced = await call(RESTART, { harness: 'claude-code', force: true })
      assertSettingsResponse(RESTART, forced)
      assert.equal(forced.state, 'running')
      assert.deepEqual(forced.snapshot.pendingRestart, [])
      rmSync(busy)
      const after = await runtimeEnv(client as TestClient, 'claude-code', 'FIXTURE_MARK')
      pids.add(after.pid)
      assert.equal(after.value, 'two')
      assert.notEqual(after.pid, before.pid)
    })

    await t.test('停用再启用：运行时停掉和起来，状态变化有通知', async () => {
      const running = await runtimeEnv(client as TestClient, 'pi', 'FIXTURE_MARK')
      const off = next(statusOf('pi', 'disabled'))
      const disabled = await call(WRITE, {
        expectedVersion: 2,
        edits: [{ key: 'harness.pi.enabled', value: false }],
      })
      assert.deepEqual(disabled.restarted, ['pi'])
      // 应答到的时候已经停了：运行时进程没了，它的 SSH 入口也收了
      assert.equal(alive(running.pid), false, 'Pi 的运行时进程退出了')
      assert.equal(entryStates(disabled.snapshot).pi, 'idle')
      const notice = await off
      assertStatusChanged(notice.params)
      assert.ok((notice.params as any).info.unavailable.text.en)
      const info = await call('runtime/info')
      assert.deepEqual(
        info.harnesses.map((item: any) => [item.id, item.unavailable?.kind ?? null]),
        [
          ['claude-code', null],
          ['pi', 'disabled'],
          ['dsh', 'notInstalled'],
          ...NEW_HARNESSES,
          ['codex', 'notInstalled'],
        ],
      )
      const refused = await (client as TestClient).fails('model/list', { harness: 'pi' })
      assert.equal(refused.data.litch, 'harnessUnavailable')
      // 它的 SSH 入口跟着收了；别的 harness 不受影响
      const read = await call(READ)
      const entries = Object.fromEntries(
        read.snapshot.sshEntries.map((item: any) => [item.harness, item.state]),
      )
      assert.equal(entries.pi, 'idle')
      assert.equal(entries['claude-code'], 'listening')
      assert.equal((await call('model/list', { harness: 'claude-code' })).data.length, 1)

      const on = next(
        (frame) => statusOf('pi', null)(frame) && frame.params.info.available === true,
      )
      const enabled = await call(WRITE, {
        expectedVersion: 3,
        edits: [{ key: 'harness.pi.enabled', value: true }],
      })
      assert.deepEqual(enabled.restarted, ['pi'])
      assert.equal(entryStates(enabled.snapshot).pi, 'listening', '应答到的时候入口已经听上了')
      await on
      const back = await runtimeEnv(client as TestClient, 'pi', 'FIXTURE_MARK')
      pids.add(back.pid)
      assert.equal(back.value, 'one', '设置里的环境变量还在')
      assert.notEqual(back.pid, running.pid)
    })

    await t.test('诊断、日志、ssh 配置片段', async () => {
      const one = await call('litch/device/diagnostics/run', { harness: 'pi' })
      assertSettingsResponse('litch/device/diagnostics/run', one)
      assert.deepEqual(
        one.checks.map((item: any) => [item.id, item.scope.harness]),
        [
          ['runtime', 'pi'],
          ['terminal', 'pi'],
          ['sshEntry', 'pi'],
        ],
      )
      assert.deepEqual(
        one.checks.slice(0, 2).map((item: any) => item.status),
        ['ok', 'ok'],
      )
      const all = await call('litch/device/diagnostics/run')
      assertSettingsResponse('litch/device/diagnostics/run', all)
      const dsh = all.checks.filter((item: any) => item.scope.harness === 'dsh')
      assert.equal(dsh[0].status, 'skipped', '没装的实验性 harness 不算毛病')
      assert.ok(dsh[0].detail.en)

      const runtime = await call('litch/device/logs/read', { source: 'runtime', harness: 'pi' })
      assertSettingsResponse('litch/device/logs/read', runtime)
      assert.match(runtime.text, /fake runtime started pi/)
      assert.equal(runtime.path, join(service.home, 'pi', 'runtime.log'))
      const device = await call('litch/device/logs/read', { source: 'device', maxBytes: 200 })
      assertSettingsResponse('litch/device/logs/read', device)
      assert.equal(device.truncated, true)
      assert.ok(Buffer.byteLength(device.text) <= 200)

      const ssh = await until(async () => {
        const current = await call('litch/device/sshConfig/read')
        return current.entries.every(
          (item: any) => NOT_RUNNING.includes(item.harness) || item.config,
        )
          ? current
          : undefined
      }, '两个入口的 ssh 配置都给得出来')
      assertSettingsResponse('litch/device/sshConfig/read', ssh)
      const pi = ssh.entries.find((item: any) => item.harness === 'pi')
      assert.match(pi.config, new RegExp(`Host ${pi.alias}\\n[^]*Port ${service.ports.pi}\\n`))
      assert.ok(ssh.text.includes(pi.config))
    })

    await t.test('可重连的终端的上限：默认值两边一致；改了不重启设备进程，当场生效', async () => {
      const read = await call(READ)
      const group = read.schema.groups.find((item: any) => item.id === 'processes')
      assert.ok(group.title['zh-CN'] && group.title.en)
      // 设置的键对着设备进程的哪一项。默认值在 Go 层和设备进程里各写了一遍，这里守着它们一样
      const fields: [string, keyof typeof DEFAULT_PROCESS_LIMITS][] = [
        ['processes.bufferBytes', 'bufferBytes'],
        ['processes.limit', 'maxProcesses'],
        ['processes.idleMs', 'idleTimeoutMs'],
        ['processes.exitedMs', 'exitedRetentionMs'],
      ]
      for (const [key, field] of fields) {
        const spec = read.schema.settings.find((item: any) => item.key === key)
        assert.deepEqual(
          [spec.group, spec.type, spec.restart, spec.default],
          ['processes', 'integer', 'none', DEFAULT_PROCESS_LIMITS[field]],
          key,
        )
        assert.ok(spec.title['zh-CN'] && spec.title.en && spec.description['zh-CN'], key)
        assert.ok(
          spec.description.en && spec.minimum <= spec.default && spec.default <= spec.maximum,
        )
        assert.equal(read.snapshot.values[key], DEFAULT_PROCESS_LIMITS[field], key)
      }
      const invalid = await (client as TestClient).fails(WRITE, {
        expectedVersion: read.snapshot.version,
        edits: [{ key: 'processes.limit', value: 0 }],
      })
      assert.equal(invalid.code, settingsErrorCode('invalidSetting'))

      // 另开一条声明了终端扩展的连接，先起一个终端
      const terminals = await TestClient.overSocket(service.socket)
      try {
        await terminals.initialize(['harness', 'deviceProcesses'])
        const spawn = (handle: string) => ({
          processHandle: handle,
          command: ['/bin/sh', '-c', 'sleep 60'],
          cwd: service.home,
          timeoutMs: null,
          outputBytesCap: null,
          litchDevice: {},
        })
        await terminals.call('process/spawn', spawn('kept'))
        const written = await call(WRITE, {
          expectedVersion: read.snapshot.version,
          edits: [{ key: 'processes.limit', value: 1 }],
        })
        assertSettingsResponse(WRITE, written)
        assert.deepEqual(
          [written.changed, written.restarted, written.snapshot.pendingRestart],
          [['processes.limit'], [], []],
          '这一组不用重启谁',
        )
        // 主进程在应答之前就把新的上限经控制通道推给了设备进程：应答一到，再起一个就被拒了，说的是新的上限
        const full = await terminals.fails('process/spawn', spawn('extra'))
        assert.deepEqual(full.data, {
          litch: 'processLimitReached',
          processHandle: 'extra',
          limit: 1,
        })
        // 设备进程没有重启：两条连接都没断，改之前起的终端还在跑
        const listed = (await terminals.call('litch/process/list', {})).data
        assert.deepEqual(
          listed.filter((item: any) => item.running).map((item: any) => item.processHandle),
          ['kept'],
        )
        await terminals.call('litch/process/kill', { processHandle: 'kept' })
        assert.equal((await call(READ)).snapshot.values['processes.limit'], 1)
      } finally {
        terminals.close()
      }
    })

    await t.test('密钥没有被发回来，也没有进任何日志', () => {
      assert.ok(!(client as TestClient).raw.join('\n').includes(SECRET), '没有哪一帧带着密钥')
      assert.ok(!service.output().includes(SECRET), '主进程打出来的字里没有')
      for (const path of ['device/device.log', 'pi/runtime.log', 'pi/diagnostics.log'])
        assert.ok(!readFileSync(join(service.home, path), 'utf8').includes(SECRET), path)
    })
  } finally {
    client?.close()
    await service.stop()
  }
  assert.ok(pids.size >= 4)
  for (const pid of pids) assert.equal(alive(pid), false, `运行时进程 ${pid} 没有留下`)
  assert.equal(existsSync(service.home), false, '临时目录删掉了')
})

test('一个 harness 都起不来：服务留着，聚合面上看得到各自的原因，填好命令行路径就起来', {
  timeout: 240_000,
}, async (t) => {
  if (spawnSync('go', ['version']).status !== 0) {
    t.skip('这台机器上没有 go，编不出适配器主进程')
    return
  }
  // 像一台什么都没装的机器：两个 harness 的命令行都指到不存在的地方，dsh 不在 PATH 里
  const service = await startService({
    CHA_CLAUDE_CLI: '/nonexistent/litch-test/claude',
    PI_CLI: '/nonexistent/litch-test/pi',
  })
  let client: TestClient | null = null
  let pid = 0
  try {
    client = await until(
      () => TestClient.overSocket(service.socket).catch(() => undefined),
      '聚合面能连',
    )
    await client.initialize(['harness', 'deviceSettings'])
    const info = await client.call('runtime/info')
    assertRuntimeInfo(info)
    assert.deepEqual(
      info.harnesses.map((item: any) => [item.id, item.available, item.unavailable.kind]),
      [
        ['claude-code', false, 'notInstalled'],
        ['pi', false, 'notInstalled'],
        ['dsh', false, 'notInstalled'],
        ...NEW_HARNESSES.map(([id, kind]) => [id, false, kind]),
        ['codex', false, 'notInstalled'],
      ],
    )
    for (const item of info.harnesses)
      assert.ok(item.unavailable.text['zh-CN'] && item.unavailable.text.en, `${item.id} 有说明`)
    // 主进程说明了为什么留着，没有照“没有可用入口”退出
    await until(
      () => (service.output().includes('现在没有可用的 harness') ? true : undefined),
      '主进程说明为什么留着',
    )
    assert.ok(!service.output().includes('没有可用的适配器入口'))
    assert.equal(service.child.exitCode, null, '主进程还在')
    // 一个运行时都没有，聚合面照常答话
    const list = await client.call('thread/list', {})
    assertThreadList(list)
    assert.deepEqual(list.data, [])
    // 四个都没列，各自为什么和 runtime/info 说的一样
    assert.deepEqual(
      list.skippedHarnesses.map((item: any) => [item.harness, item.reason, item.kind]),
      info.harnesses.map((item: any) => [item.id, 'unavailable', item.unavailable.kind]),
    )
    assert.deepEqual(
      list.skippedHarnesses.map((item: any) => item.message),
      info.harnesses.map((item: any) => item.unavailable.message),
    )

    // 在设置里把 Pi 的命令行路径填对：它没在跑，写入之后直接照新设置再试，起来了
    const up = client.waitFor(
      (frame) => statusOf('pi', null)(frame) && (frame.params as any).info.available === true,
      30_000,
    )
    const written = await client.call(WRITE, {
      expectedVersion: 0,
      edits: [{ key: 'harness.pi.cliPath', value: process.execPath }],
    })
    assertSettingsResponse(WRITE, written)
    assert.deepEqual(written.restarted, ['pi'])
    assertStatusChanged((await up).params)
    const running = await runtimeEnv(client, 'pi', 'PI_CLI')
    assert.equal(running.value, process.execPath, '设置里的路径盖过了启动进程环境里的')
    pid = running.pid

    // Claude Code 还是没装：再试一次，原因照旧报回来
    const retried = await client.call(RESTART, { harness: 'claude-code' })
    assertSettingsResponse(RESTART, retried)
    assert.equal(retried.state, 'notInstalled')
    assert.ok(retried.text.en)
    const after = await client.call('runtime/info')
    assertRuntimeInfo(after)
    assert.deepEqual(
      after.harnesses.map((item: any) => [item.id, item.unavailable?.kind ?? null]),
      [
        ['claude-code', 'notInstalled'],
        ['pi', null],
        ['dsh', 'notInstalled'],
        ...NEW_HARNESSES,
        ['codex', 'notInstalled'],
      ],
    )
  } finally {
    client?.close()
    await service.stop()
  }
  assert.ok(pid > 0 && !alive(pid), '运行时进程没有留下')
  assert.equal(existsSync(service.home), false, '临时目录删掉了')
})
