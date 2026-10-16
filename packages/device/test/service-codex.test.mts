// 端到端：真的适配器主进程（Go，现编出来）拉起真的设备进程，原生 codex 的位置上是一个假的 codex 命令行
// （fake-codex-process.mts）。客户端只连聚合面这一条，把原生 codex 从“没装、不启用”走到“跑完一个回合”：
// 在设置里打开、版本过低、版本够了起来、会话列表合并、新建会话、回合、审批往返、不支持的错误、关掉再打开、没装。
// 这台机器上真的 codex 不会被碰到：主进程的 PATH 里没有它，命令行路径在设置里写明是假的那个。
// 对着真的 codex 的检查是 scripts/check-native-codex.mjs。
import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertDeclaration,
  assertErrorData,
  assertRuntimeInfo,
  assertStatusChanged,
  REPO,
  settle,
  TestClient,
  tempDir,
} from './helpers.mjs'

const STATUS = 'litch/harness/status/changed'
const READ = 'litch/device/settings/read'
const WRITE = 'litch/device/settings/write'
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
  /** 假的 codex 命令行 */
  codex: string
  output(): string
  stop(): Promise<void>
}

async function startService(): Promise<Service> {
  const root = tempDir()
  const binary = join(root, 'cha')
  const built = spawnSync('go', ['build', '-o', binary, './cmd/codex-harness-adapter'], {
    cwd: REPO,
    encoding: 'utf8',
  })
  if (built.status !== 0) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`适配器主进程没有编出来：\n${built.stderr}`)
  }
  // 三个引擎的位置上放假的运行时，设备进程用真的；原生 codex 是 bin 目录里那个假的命令行
  const stage = join(root, 'r')
  const entry = (name: string, source: string) => {
    const path = join(stage, 'packages', name, 'dist', name, 'src', `${source}.mjs`)
    mkdirSync(dirname(path), { recursive: true })
    return path
  }
  const runtime = pathToFileURL(join(HERE, 'fake-runtime.mjs')).href
  for (const [name, engine] of [
    ['claude', 'claude-code'],
    ['pi', 'pi'],
    ['dsh', 'dsh'],
  ] as const)
    writeFileSync(
      entry(name, 'adapter'),
      `import { run } from ${JSON.stringify(runtime)}\nrun(${JSON.stringify(engine)})\n`,
    )
  writeFileSync(
    entry('device', 'main'),
    `import ${JSON.stringify(pathToFileURL(join(HERE, '../src/main.mjs')).href)}\n`,
  )
  const codex = join(root, 'bin', 'codex')
  mkdirSync(dirname(codex))
  writeFileSync(
    codex,
    `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, 'fake-codex-process.mjs')}" "$@"\n`,
  )
  chmodSync(codex, 0o700)
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
      // 干净的环境：PATH 里没有 dsh，也没有 codex
      env: {
        PATH: '/usr/bin:/bin',
        HOME: userHome,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        CHA_LANG: 'zh-CN',
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
  return { child, home, socket, codex, output: () => output, stop }
}

const statusOf =
  (kind: string | null) =>
  (frame: { method?: string; params?: unknown }): boolean => {
    const params = frame.params as any
    return (
      frame.method === STATUS &&
      params.harness === 'codex' &&
      (params.info.unavailable?.kind ?? null) === kind
    )
  }

test('真的主进程加真的设备进程加假的 codex 命令行：原生 codex 从没装到跑完一个回合', {
  timeout: 240_000,
}, async (t) => {
  if (spawnSync('go', ['version']).status !== 0) {
    t.skip('这台机器上没有 go，编不出适配器主进程')
    return
  }
  const service = await startService()
  let client: TestClient | null = null
  try {
    const connected = await until(
      () => TestClient.overSocket(service.socket).catch(() => undefined),
      '聚合面能连',
    )
    client = connected
    await connected.initialize(['harness', 'deviceSettings', 'declineWithNote'])
    const call = (method: string, params?: unknown) => connected.call(method, params)
    const codexOf = async () =>
      (await call('runtime/info')).harnesses.find((item: any) => item.id === 'codex')
    /** 从现在起收到的通知里找 */
    const next = (predicate: (frame: any) => boolean) => {
      const from = connected.notifications.length
      return connected.waitFor(
        (frame) => connected.notifications.indexOf(frame) >= from && predicate(frame),
        30_000,
      )
    }
    let version = 0
    const write = async (edits: { key: string; value: unknown }[]) => {
      const written = await call(WRITE, { expectedVersion: version, edits })
      version = written.snapshot.version
      return written
    }
    const directory = join(service.home, 'codex')
    const pid = () => Number(readFileSync(join(directory, 'fake-codex.pid'), 'utf8'))
    const env = (value: string) => ({
      key: 'harness.codex.env',
      value: [{ name: 'FAKE_CODEX_VERSION', value }],
    })

    await t.test('没装就不启用：名单里有它并说明原因，设置里有它的三项，什么都没有起', async () => {
      const info = await call('runtime/info')
      assertRuntimeInfo(info)
      const codex = info.harnesses.at(-1)
      assert.deepEqual(
        [codex.id, codex.displayName, codex.badge, codex.available, codex.unavailable.kind],
        ['codex', 'Codex', 'CX', false, 'notInstalled'],
      )
      assert.ok(codex.unavailable.text['zh-CN'] && codex.unavailable.text.en)
      const read = await call(READ)
      assert.equal(read.snapshot.values['harness.codex.enabled'], false)
      const keys = read.schema.settings.map((item: any) => item.key)
      for (const key of ['harness.codex.enabled', 'harness.codex.cliPath', 'harness.codex.env'])
        assert.ok(keys.includes(key), `结构里有 ${key}`)
      assert.ok(!keys.some((key: string) => key.startsWith('ssh.codex.')), '它没有 SSH 入口')
      assert.ok(!read.snapshot.sshEntries.some((item: any) => item.harness === 'codex'))
      assert.equal(existsSync(directory), false)
    })

    await t.test('在设置里打开：版本低于下限时如实报，换成够的版本就起来，声明带着', async () => {
      const low = next(statusOf('versionTooLow'))
      const written = await write([
        { key: 'harness.codex.enabled', value: true },
        { key: 'harness.codex.cliPath', value: service.codex },
        env('0.149.0'),
      ])
      assert.deepEqual(written.restarted, ['codex'], '它没在跑，写入之后直接照新设置去起')
      const refused = await low
      assertStatusChanged(refused.params)
      assert.match((refused.params as any).info.unavailable.message, /0\.149\.0.*0\.157\.1/)
      assert.equal(existsSync(join(directory, 'fake-codex.pid')), false, '版本不够就不起')

      const up = next((frame) => statusOf(null)(frame) && frame.params.info.available === true)
      assert.deepEqual((await write([env('0.160.0')])).restarted, ['codex'])
      const notice = await up
      assertStatusChanged(notice.params)
      const codex = await codexOf()
      assert.deepEqual(
        [codex.available, codex.version, codex.engine, codex.extensions],
        [true, '0.160.0', 'codex', ['clientTools']],
      )
      assertDeclaration(codex)
      assert.ok(alive(pid()))
    })

    await t.test('握手：到它的每一条连接都不带我们的扩展键', () => {
      const greetings = readFileSync(join(directory, 'greetings.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      const names = greetings.map((greeting) => greeting.clientInfo.name)
      assert.ok(names.includes('device-test'), `客户端那条连接握过手：${names}`)
      for (const greeting of greetings)
        assert.equal(greeting.capabilities.litchExtensions, undefined)
      const mine = greetings.find((greeting) => greeting.clientInfo.name === 'device-test')
      assert.equal(mine.capabilities.experimentalApi, true)
    })

    await t.test('会话列表合并，新建会话，回合里审批往返，权限预设配上审批策略', async () => {
      const list = await call('thread/list', { limit: 10 })
      assert.deepEqual(
        list.data.map((thread: any) => [thread.id, thread.harness]),
        [['019a0000-0000-7000-8000-00000000c0de', 'codex']],
      )
      const started = await call('thread/start', { harness: 'codex', cwd: '/work/e2e' })
      assert.equal(started.thread.harness, 'codex')
      const threadId = started.thread.id
      const done = next((frame) => frame.method === 'turn/completed')
      const turn = await call('turn/start', {
        threadId,
        input: [{ type: 'text', text: '跑一下', text_elements: [] }],
        permissions: ':workspace',
      })
      assert.equal(turn.turn.status, 'inProgress')
      const approval = await connected.waitFor(
        (frame) => frame.method === 'item/commandExecution/requestApproval',
        30_000,
      )
      // 请求号是它那种整数；决定列表是它自己给的，没有被改
      assert.equal(typeof approval.id, 'number')
      assert.deepEqual((approval.params as any).availableDecisions, ['accept', 'cancel'])
      connected.answer(approval.id, { decision: 'accept' })
      const completed = await done
      const reply = (completed.params as any).turn.items[0].text
      assert.match(reply, /决定是 "accept"/)
      assert.match(reply, /审批策略是 on-request/)
      await connected.waitFor((frame) => frame.method === 'serverRequest/resolved')
    })

    await t.test('它不认识的方法：聚合面一致的“不支持”', async () => {
      const failure = await connected.fails('thread/rollback', {
        harness: 'codex',
        numTurns: 1,
      })
      assert.equal(failure.code, -32601)
      assert.deepEqual(failure.data, {
        litch: 'unsupported',
        method: 'thread/rollback',
        harness: 'codex',
      })
      assertErrorData(failure.data)
    })

    await t.test('运行中关掉再打开；命令行路径不对时报没装', async () => {
      const before = pid()
      const off = next(statusOf('disabled'))
      assert.deepEqual((await write([{ key: 'harness.codex.enabled', value: false }])).restarted, [
        'codex',
      ])
      assertStatusChanged((await off).params)
      await until(() => (alive(before) ? undefined : true), '假的 codex 进程退出')
      const refused = await connected.fails('model/list', { harness: 'codex' })
      assert.equal(refused.data.litch, 'harnessUnavailable')
      assert.equal((await call('model/list', { harness: 'pi' })).data.length, 1)

      const on = next((frame) => statusOf(null)(frame) && frame.params.info.available === true)
      await write([{ key: 'harness.codex.enabled', value: true }])
      await on
      assert.notEqual(pid(), before)
      assert.equal((await call('model/list', { harness: 'codex' })).data[0].id, 'fake-codex-model')

      const running = pid()
      const gone = next(statusOf('notInstalled'))
      await write([{ key: 'harness.codex.cliPath', value: join(service.home, 'no-such-codex') }])
      const missing = await gone
      assert.ok((missing.params as any).info.unavailable.text.en)
      await until(() => (alive(running) ? undefined : true), '假的 codex 进程退出')
    })
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : error}\n主进程的输出：\n${service.output()}`,
    )
  } finally {
    client?.close()
    await service.stop()
  }
})
