// 端到端：真的适配器主进程（Go，现编出来，版本号钉死）用 device-start 拉起，带着真的设备进程和假的运行时。
// 看三件事连起来对不对：服务报自己是哪一份（就绪行、service.json、聚合面上的 device.service 是同一份）；
// device-stop --if-idle 在忙的时候不停并说出是哪一种忙；闲了停得掉、停完能紧跟着再起。
// 状态目录、用户主目录都在临时目录里，不开 SSH 入口（--ssh=off，不监听任何端口），不碰任何真的 harness。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertDeviceService,
  assertRuntimeInfo,
  REPO,
  settle,
  TestClient,
  tempDir,
} from './helpers.mjs'

/** 编译出来的测试所在的目录（dist/device/test），假运行时就在这里 */
const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = '7.7.7'

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
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await attempt()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒没有等到：${what}`)
    await settle(100)
  }
}

interface Ran {
  code: number | null
  /** 标准输出最后一行的 JSON：命令的结果 */
  result: any
  stderr: string
}

/** 一份现编的适配器，和一个空的状态目录。run 用它执行一条命令，等它结束 */
function stage() {
  const root = tempDir()
  const binary = join(root, 'cha')
  const built = spawnSync(
    'go',
    ['build', '-ldflags', `-X main.buildVersion=${VERSION}`, '-o', binary, '.'],
    { cwd: join(REPO, 'cmd/codex-harness-adapter'), encoding: 'utf8' },
  )
  assert.equal(built.status, 0, `适配器主进程没有编出来：\n${built.stderr}`)
  // 主进程按 <root>/packages/<名字>/dist/… 找运行时和设备进程：运行时的位置上放假的，设备进程用真的
  const adapter = join(root, 'r')
  const entry = (name: string, source: string) => {
    const path = join(adapter, 'packages', name, 'dist', name, 'src', `${source}.mjs`)
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
  const home = join(root, 'h')
  const userHome = join(root, 'u')
  mkdirSync(userHome)
  const run = (...args: string[]): Ran => {
    const done = spawnSync(binary, args, {
      // 干净的环境：不带个人的任何凭据和配置；PATH 里没有 dsh，它算没装
      env: {
        PATH: '/usr/bin:/bin',
        HOME: userHome,
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        CHA_LANG: 'zh-CN',
      },
      encoding: 'utf8',
      timeout: 120_000,
    })
    const last = done.stdout.trim().split('\n').pop() ?? ''
    return { code: done.status, result: last ? JSON.parse(last) : null, stderr: done.stderr }
  }
  const start = () =>
    run('device-start', '--home', home, '--root', adapter, '--node', process.execPath, '--ssh=off')
  const stop = (...more: string[]) => run('device-stop', '--home', home, ...more)
  return { root, adapter, home, socket: join(home, 'device', 'device.sock'), start, stop }
}

test('服务报自己是哪一份；device-stop 忙的时候不停并说明原因，闲了停得掉、能紧跟着再起', {
  timeout: 300_000,
}, async (t) => {
  if (spawnSync('go', ['version']).status !== 0) {
    t.skip('这台机器上没有 go，编不出适配器主进程')
    return
  }
  const kit = stage()
  /** 这个用例自己拉起来的常驻进程，收场时要确认都不在了 */
  const services = new Set<number>()
  const clients: TestClient[] = []
  const connect = async (extensions: string[] | null) => {
    const client = await until(
      () => TestClient.overSocket(kit.socket).catch(() => undefined),
      '聚合面能连',
    )
    clients.push(client)
    await client.initialize(extensions ?? undefined)
    return client
  }
  try {
    await t.test('没在运行：device-stop 也算成功', () => {
      const none = kit.stop('--if-idle')
      assert.deepEqual([none.code, none.result], [0, { result: 'notRunning' }], none.stderr)
    })

    const first = kit.start()
    assert.equal(first.code, 0, first.stderr)
    services.add(first.result.pid)
    const facts = first.result.service

    await t.test('就绪行、service.json、聚合面上的 device.service 是同一份来历', async () => {
      assert.equal(first.result.started, true)
      assert.deepEqual(
        [facts.pid, facts.version, facts.root, facts.detached],
        [first.result.pid, VERSION, kit.adapter, true],
      )
      assert.deepEqual(facts.options.slice(0, 1), ['--ssh=off'], '启动时带的参数记下来了')
      // 拉起服务的就是执行这条命令的这一份
      assert.deepEqual(first.result.cli, {
        version: VERSION,
        root: kit.adapter,
        build: facts.build,
      })
      const status = JSON.parse(readFileSync(join(kit.home, 'device', 'service.json'), 'utf8'))
      assert.deepEqual(status.service, facts)

      const aware = await connect(['harness', 'deviceService'])
      const info = await aware.call('runtime/info')
      assertRuntimeInfo(info)
      assert.ok(info.device.extensions.includes('deviceService'))
      assertDeviceService(info.device.service)
      const { options: _options, ...reported } = facts
      assert.deepEqual(info.device.service, reported, '客户端问到的和就绪行里的是同一份')

      // 没声明的连接上没有这个字段
      const plain = await connect(null)
      const seen = await plain.call('runtime/info')
      assertRuntimeInfo(seen)
      assert.equal('service' in seen.device, false)

      // 再执行一次 device-start：服务还是那一份，如实报出来
      const again = kit.start()
      assert.deepEqual(
        [again.code, again.result.started, again.result.pid, again.result.service],
        [0, false, facts.pid, facts],
      )
    })

    await t.test('--if-idle：有客户端连着、有回合在跑、有属于设备的终端在跑，都不停', async () => {
      const held = kit.stop('--if-idle')
      assert.equal(held.code, 4, held.stderr)
      assert.deepEqual(held.result, {
        result: 'busy',
        pid: facts.pid,
        service: facts,
        busy: [{ reason: 'clients', count: 2 }],
      })
      assert.match(held.stderr, /2 个客户端/)

      // 再添两样：一个正在跑回合的会话，一个属于设备的终端
      const busy = join(kit.home, 'claude-code', 'busy')
      writeFileSync(busy, '')
      const terminals = await connect(['harness', 'deviceProcesses'])
      await terminals.call('process/spawn', {
        processHandle: 'kept',
        command: ['/bin/sh', '-c', 'sleep 120'],
        cwd: kit.home,
        timeoutMs: null,
        outputBytesCap: null,
        litchDevice: {},
      })
      assert.deepEqual(kit.stop('--if-idle').result.busy, [
        { reason: 'activeTurns', harnesses: ['claude-code'] },
        { reason: 'deviceProcesses', count: 1 },
        { reason: 'clients', count: 3 },
      ])

      // 客户端都走了：回合和终端还在，照样不停（这时候反复问是安全的，它停不了）
      for (const client of clients.splice(0)) client.close()
      const left = await until(() => {
        const now = kit.stop('--if-idle')
        return now.result.busy.some((item: any) => item.reason === 'clients') ? undefined : now
      }, '连接都断开')
      assert.equal(left.code, 4)
      assert.deepEqual(left.result.busy, [
        { reason: 'activeTurns', harnesses: ['claude-code'] },
        { reason: 'deviceProcesses', count: 1 },
      ])
      rmSync(busy)
      assert.deepEqual(kit.stop('--if-idle').result.busy, [{ reason: 'deviceProcesses', count: 1 }])
      assert.ok(alive(facts.pid), '问了这么多遍，服务一直在')
    })

    await t.test('闲下来就停掉，等它退出；再停一次还是成功', async () => {
      const closer = await connect(['harness', 'deviceProcesses'])
      await closer.call('litch/process/kill', { processHandle: 'kept' })
      closer.close()
      clients.length = 0
      // 终端结束、连接断开都要一小会儿：还忙着的那几次不停，闲了的那一次停掉
      const stopped = await until(() => {
        const now = kit.stop('--if-idle')
        if (now.code === 4) return undefined
        return now
      }, '服务闲下来')
      assert.equal(stopped.code, 0, stopped.stderr)
      assert.deepEqual(stopped.result, { result: 'stopped', pid: facts.pid, service: facts })
      // 命令返回时它已经退出了，套接字和状况文件也收走了
      assert.equal(alive(facts.pid), false)
      assert.equal(existsSync(kit.socket), false)
      assert.equal(existsSync(join(kit.home, 'device', 'service.json')), false)
      assert.deepEqual(kit.stop().result, { result: 'notRunning' })
    })

    await t.test('停完紧跟着再起：是新的一份；不带 --if-idle 时有客户端连着也停', async () => {
      const second = kit.start()
      assert.equal(second.code, 0, second.stderr)
      services.add(second.result.pid)
      assert.equal(second.result.started, true)
      assert.notEqual(second.result.pid, facts.pid)
      assert.ok(second.result.service.startedAt >= facts.startedAt)
      const client = await connect(['harness', 'deviceService'])
      assert.equal((await client.call('runtime/info')).device.service.pid, second.result.pid)
      const forced = kit.stop()
      assert.deepEqual(
        [forced.code, forced.result.result, forced.result.pid],
        [0, 'stopped', second.result.pid],
        forced.stderr,
      )
      assert.equal(alive(second.result.pid), false)
    })
  } finally {
    for (const client of clients) client.close()
    // 用例半路失败时把自己拉起来的服务收掉：先照规矩请它停，不行再对记下的进程号发信号
    if ([...services].some(alive)) kit.stop()
    for (const pid of services) if (alive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(kit.root, { recursive: true, force: true })
  }
  for (const pid of services) assert.equal(alive(pid), false, `常驻进程 ${pid} 没有留下`)
})
