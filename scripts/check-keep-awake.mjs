// 真机电源验收：隔离HOME、Pi和回环假模型，不修改系统睡眠配置。
// node scripts/check-keep-awake.mjs
// 只验证断言，不改变显示器状态。锁屏/合盖必须另行安排有人在场的手工验收。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

if (process.platform !== 'darwin') throw new Error('这个真机验收只在 macOS 运行')
if (process.argv.length > 2) throw new Error('本脚本不接受显示器或锁屏操作参数')
const repo = fileURLToPath(new URL('..', import.meta.url))
const bin = join(repo, 'bin/codex-harness-adapter')
const read = 'litch/device/power/read'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const records = []
const record = (name, detail = {}) => {
  records.push({ name, at: new Date().toISOString(), ...detail })
  console.log(JSON.stringify(records.at(-1)))
}
const until = async (get, accept, timeout = 15000) => {
  const deadline = Date.now() + timeout
  let last
  do {
    last = await get()
    if (accept(last)) return last
    await sleep(300)
  } while (Date.now() < deadline)
  throw new Error(`等待超时: ${JSON.stringify(last)}`)
}
const run = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '',
      err = ''
    child.stdout.on('data', (b) => {
      out += b
    })
    child.stderr.on('data', (b) => {
      err += b
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${command}: ${code}: ${err}`)),
    )
  })
class Rpc {
  pending = new Map()
  notes = []
  sequence = 0
  constructor(socket) {
    this.socket = new WebSocket('ws://localhost/', {
      createConnection: () => net.createConnection({ path: socket }),
    })
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
    this.socket.on('message', (chunk) => {
      try {
        const frame = JSON.parse(chunk.toString())
        if (frame.id !== undefined && !frame.method) {
          const pending = this.pending.get(frame.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pending.delete(frame.id)
            frame.error
              ? pending.reject(new Error(JSON.stringify(frame.error)))
              : pending.resolve(frame.result)
          }
        } else this.notes.push(frame)
      } catch {
        this.socket.terminate()
      }
    })
    const end = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('连接已关闭'))
      }
      this.pending.clear()
    }
    this.socket.on('error', end)
    this.socket.on('close', end)
  }
  async call(method, params = {}) {
    await this.ready
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}超时`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'keep-awake-check', version: '1' },
      capabilities: {
        experimentalApi: true,
        litchExtensions: ['harness', 'deviceSettings', 'devicePower'],
      },
    })
    this.socket.send(JSON.stringify({ method: 'initialized' }))
  }
  close() {
    this.socket.terminate()
  }
}
const assertions = () => execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' })
const children = (pid) => {
  const table = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  return table.split('\n').flatMap((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return m && Number(m[2]) === pid && m[3].endsWith('caffeinate') ? [Number(m[1])] : []
  })
}
const holds = (pid) => {
  const all = assertions()
  return children(pid).flatMap((child) =>
    all
      .split('\n')
      .filter(
        (line) => line.includes(`pid ${child}(`) && line.includes('PreventUserIdleSystemSleep'),
      ),
  )
}
const fixtureProcess = spawn(
  process.execPath,
  ['scripts/client-local-fixture.mjs', '--adapter', repo, '--pace', '6000'],
  { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] },
)
let fixture, client, second, service
let fixtureOutput = ''
fixtureProcess.stderr.on('data', (b) => process.stderr.write(b))
try {
  fixture = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 15000)
    fixtureProcess.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`夹具退出 ${code}`))
    })
    fixtureProcess.stdout.on('data', (chunk) => {
      fixtureOutput += chunk
      const line = fixtureOutput.split('\n').find((line) => line.startsWith('LITCH_LOCAL_FIXTURE '))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice('LITCH_LOCAL_FIXTURE '.length)))
      }
    })
  })
  const env = {
    HOME: fixture.login.home,
    PATH: fixture.login.path,
    TMPDIR: join(fixture.root, 'tmp'),
  }
  const args = [
    'device-start',
    '--home',
    fixture.home,
    '--root',
    repo,
    '--node',
    process.execPath,
    '--harness',
    'pi',
    '--ssh=off',
  ]
  // 未登记服务先验证没有设置、没有进程；随后同一PID登记，不能重启它。
  service = JSON.parse(await run(bin, args, env))
  client = new Rpc(fixture.socket)
  await client.initialize()
  assert.equal((await client.call(read)).configuredForLocalService, false)
  assert.equal(children(service.pid).length, 0)
  assert.equal(
    (await client.call('litch/device/settings/read')).schema.groups.some((g) => g.id === 'power'),
    false,
  )
  const registered = JSON.parse(await run(bin, [...args, '--local-service'], env))
  assert.equal(registered.pid, service.pid)
  second = new Rpc(fixture.socket)
  await second.initialize()
  const setting = await second.call('litch/device/settings/read')
  assert.equal(setting.snapshot.values['power.preventSleepWhileWorking'], true)
  assert.equal(setting.snapshot.values['power.keepAwakeWhilePluggedIn'], false)
  record('未登记不启用；已有服务原地登记；双客户端可见开关', { pid: service.pid })
  const write = async (key, value) => {
    const current = await second.call('litch/device/settings/read')
    await second.call('litch/device/settings/write', {
      expectedVersion: current.snapshot.version,
      edits: [{ key, value }],
    })
  }
  await until(
    () => client.call('runtime/info'),
    (info) => info.harnesses.some((h) => h.id === 'pi' && h.available !== false),
  )
  const born = await client.call('thread/start', {
    harness: 'pi',
    cwd: fixture.cwd,
    model: fixture.model,
    approvalPolicy: 'never',
  })
  const threadId = born.thread.id
  await client.call('turn/start', {
    threadId,
    input: [{ type: 'text', text: '回声：验证工作期间的电源断言' }],
  })
  await until(
    () => client.call(read),
    (state) => state.state === 'requested' && state.working > 0,
  )
  const assertion = await until(
    () => holds(service.pid),
    (lines) => lines.length > 0,
  )
  record('真实Pi回合持有系统空闲睡眠断言', { assertion })
  await until(
    () => client.notes,
    (notes) => notes.some((n) => n.method === 'turn/completed' && n.params?.threadId === threadId),
    90000,
  )
  record('真实Pi回合完成；锁屏行为不在本脚本验收范围内')
  await until(
    () => client.call(read),
    (state) => state.state === 'inactive',
    45000,
  )
  assert.equal(holds(service.pid).length, 0)
  assert.equal(children(service.pid).length, 0)
  record('回合结束宽限后释放；无caffeinate子进程')
  await write('power.keepAwakeWhilePluggedIn', true)
  const idle = await until(
    () => client.call(read),
    (state) => state.state === 'requested' && state.reasons.includes('pluggedIn'),
  )
  assert.equal(idle.powerSource, 'ac')
  client.close()
  client = null
  second.close()
  second = null
  await sleep(65000)
  assert.ok(holds(service.pid).length > 0)
  record('接电常开：无客户端空闲65秒后仍持有，续租有效', { assertion: holds(service.pid) })
  second = new Rpc(fixture.socket)
  await second.initialize()
  await write('power.keepAwakeWhilePluggedIn', false)
  await until(
    () => children(service.pid),
    (pids) => pids.length === 0,
  )
  record('另一客户端即时关闭常开，无需重启', { pid: service.pid })
  await write('power.keepAwakeWhilePluggedIn', true)
  await until(
    () => holds(service.pid),
    (lines) => lines.length > 0,
  )
  const pids = children(service.pid)
  process.kill(service.pid, 'SIGKILL')
  await until(
    () => assertions(),
    (all) => pids.every((pid) => !all.includes(`pid ${pid}(`)),
  )
  await until(
    () => execFileSync('/bin/ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }),
    (all) => pids.every((pid) => !new RegExp(`^\\s*${pid}\\s+.*caffeinate$`, 'm').test(all)),
  )
  record('常驻服务SIGKILL后无孤儿caffeinate、无遗留断言', { pids })
} finally {
  client?.close()
  second?.close()
  if (fixture) await fetch(fixture.stopUrl, { method: 'POST' }).catch(() => {})
  else fixtureProcess.kill('SIGTERM')
  mkdirSync(join(repo, '.local'), { recursive: true })
  writeFileSync(
    join(repo, '.local/keep-awake-report.json'),
    JSON.stringify({ records, passwordLock: '未验', lid: '未验', battery: '未验' }, null, 2),
  )
}
