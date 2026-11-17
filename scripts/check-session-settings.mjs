// 原生 Codex + 正式 core + 回环假模型；不读取个人配置，不访问外网。
// node --import tsx scripts/check-session-settings.mjs，CHA_CODEX_CLI 必须指向隔离安装的 CLI。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createCore } from '../packages/core/src/index.mts'
import { codexConfig, startResponsesModel } from './client-fixture-responses.mjs'

const cli = process.env.CHA_CODEX_CLI
assert.ok(cli, 'CHA_CODEX_CLI 必须指向隔离安装的官方 Codex')
const root = await mkdtemp(join(tmpdir(), 'litch-settings-'))
const home = join(root, 'home')
const codexHome = join(root, 'codex')
const work = join(root, 'work')
for (const path of [home, codexHome, work]) await mkdir(path)
const samples = []
const model = await startResponsesModel((body) => {
  samples.push(body)
  return { text: 'SETTINGS_FIXTURE_COMPLETE' }
})
await writeFile(join(codexHome, 'config.toml'), codexConfig(model.baseUrl))
const env = {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: codexHome,
  TMPDIR: root,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  RUST_LOG: 'error',
}
const version = execFileSync(cli, ['--version'], { env, encoding: 'utf8' }).trim()
const timers = new Set()
const clock = {
  now: Date.now,
  setTimer(fn, ms) {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    return () => {
      clearTimeout(timer)
      timers.delete(timer)
    }
  },
}
const until = async (read, label) => {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等不到：${label}`)
}

function start() {
  const child = spawn(cli, ['app-server', '--listen', 'stdio://'], {
    cwd: work,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (value) => {
    stderr = (stderr + value).slice(-4000)
  })
  const exit = once(child, 'exit')
  let sink
  let seq = 0
  const pending = new Map()
  const completed = new Set()
  const trace = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    const value = JSON.parse(line)
    if (value.method === 'turn/completed') completed.add(value.params.turn.id)
    const waiting = pending.get(value.id)
    if (waiting) {
      pending.delete(value.id)
      clearTimeout(waiting.timer)
      if (value.error) waiting.reject(new Error(JSON.stringify(value.error)))
      else waiting.resolve(value.result)
    } else sink?.message(line)
  })
  child.once('exit', () => {
    sink?.close(stderr || null)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(`Codex 退出：${stderr}`))
    }
  })
  const raw = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `fixture:${++seq}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} 超时：${stderr}`))
      }, 20_000)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  return {
    raw,
    completed,
    trace,
    open: async () => ({
      send(text) {
        trace.push(JSON.parse(text))
        child.stdin.write(`${text}\n`)
      },
      listen(handlers) {
        sink = handlers
      },
      close() {
        child.kill('SIGTERM')
      },
    }),
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exit
    },
  }
}

let processFixture = start()
const core = createCore({
  clock,
  version: '0.44.0',
  devices: [
    {
      id: 'local',
      name: '隔离 Codex',
      kind: 'local',
      host: 'fixture',
      wire: 'green',
      target: null,
      open: processFixture.open,
    },
  ],
})
const command = (name, params) =>
  core.command(name, params, { aborted: false, addEventListener() {} })
let online = false
core.subscribe(
  { kind: 'app' },
  {
    snapshot(view) {
      online = view.devices.some((device) => device.connection === 'online')
    },
    delta(ops) {
      for (const op of ops)
        if (op.op === 'device.upsert') online = op.device.connection === 'online'
    },
    error(error) {
      throw new Error(JSON.stringify(error))
    },
  },
)
try {
  core.start()
  await until(() => online, '核心握手')
  const models = await processFixture.raw('model/list', {})
  const selectedModel = models.data.find((model) =>
    model.serviceTiers?.some((tier) => tier.id === 'priority'),
  )?.model
  assert.ok(selectedModel, '隔离 Codex 模型目录必须包含支持 priority 的型号')
  const { sessionId } = await command('session.create', {
    deviceId: 'local',
    cwd: work,
    text: '创建隔离会话',
    settings: { model: 'fixture-gate', effort: 'low', permission: ':workspace' },
  })
  const first = processFixture.trace.find((entry) => entry.method === 'turn/start')
  await until(() => processFixture.completed.size > 0, '首回合完成')
  assert.equal(samples[0].reasoning.effort, 'low')
  await command('session.configure', {
    deviceId: 'local',
    sessionId,
    settings: {
      model: selectedModel,
      effort: 'high',
      speed: 'priority',
      permission: ':danger-full-access',
    },
  })
  assert.ok(first)
  assert.equal(samples.length, 1, '切换不额外发送用户消息')
  for (const source of ['task', 'wake', 'background', 'manager', 'user']) {
    const { turn } = await processFixture.raw('turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: `隔离来源 ${source}`, text_elements: [] }],
    })
    await until(() => processFixture.completed.has(turn.id), `${source}回合完成`)
    const body = samples.at(-1)
    assert.equal(body.model, selectedModel, source)
    assert.equal(body.reasoning.effort, 'high', source)
    assert.equal(body.service_tier, 'priority', source)
  }
  core.stop()
  await processFixture.close()
  processFixture = start()
  await processFixture.raw('initialize', {
    clientInfo: { name: 'settings-fixture', version: '1' },
    capabilities: { experimentalApi: true },
  })
  // 速度由设备/核心的既有记账恢复；型号和强度必须从 Codex 的线程记录恢复。
  const resumed = await processFixture.raw('thread/resume', {
    threadId: sessionId,
    excludeTurns: true,
    serviceTier: 'priority',
  })
  assert.equal(resumed.model, selectedModel)
  assert.equal(resumed.reasoningEffort, 'high')
  assert.equal(resumed.serviceTier, 'priority')
  assert.equal(resumed.sandbox.type, 'dangerFullAccess')
  console.log(
    `${version}：核心切换立即写入；五类无覆盖参数回合使用新模型/强度/速度；重启恢复模型、强度、权限通过。`,
  )
} finally {
  core.stop()
  await processFixture.close()
  model.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  // 夹具不再保留 core 的延迟退订或快照定时器；只清理本次时钟创建的句柄。
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
}
