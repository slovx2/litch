// 真原生 Codex + 真设备进程 + 回环假 Responses：验证登记、释放回合、离线完成与接续。
// 先 npm run build --prefix packages/device；CHA_CODEX_CLI 必须指隔离准备的官方 CLI。
// 环境从零构造，绝不读取个人模型凭据或真实 HOME/CODEX_HOME。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { DeviceServer } from '../packages/device/dist/device/src/device.mjs'
import { TestClient } from '../packages/device/dist/device/test/helpers.mjs'
import { codexConfig, startResponsesModel } from './client-fixture-responses.mjs'

const cli = process.env.CHA_CODEX_CLI
if (!cli) throw new Error('CHA_CODEX_CLI must point to an isolated official Codex CLI')
const root = mkdtempSync(join(tmpdir(), 'litch-native-wake-'))
const dirs = Object.fromEntries(
  ['home', 'codex', 'tmp', 'work', 'device'].map((key) => [key, join(root, key)]),
)
for (const dir of Object.values(dirs)) mkdirSync(dir)
let stage = 0
let continued = false
const samples = []
const respond = (body) => {
  samples.push(body)
  const input = JSON.stringify(body.input)
  if (
    input.includes('"namespace":"litch_background","name":"completed"') ||
    input.includes('"batchId"') ||
    input.includes('\\"batchId\\"')
  ) {
    continued = true
    return { text: 'BACKGROUND_RESULT_HANDLED' }
  }
  if (stage++ === 0) {
    assert.ok(JSON.stringify(body.tools).includes('litch_background'))
    assert.ok(input.includes('explicit delegation is the exception'))
    return {
      call: {
        namespace: 'functions',
        name: 'exec_command',
        arguments: JSON.stringify({
          cmd: 'sleep 3; echo WAKE_NATIVE_RESULT; exit 7',
          yield_time_ms: 1000,
          max_output_tokens: 1000,
        }),
      },
    }
  }
  if (stage === 2) {
    const match = /session ID (\d+)/i.exec(input)
    assert.ok(match, 'native session id returned to model')
    return {
      call: {
        namespace: 'litch_background',
        name: 'watch',
        arguments: JSON.stringify({
          session_id: match[1],
          purpose: 'Report the exit code and output of the finite test.',
        }),
      },
    }
  }
  assert.ok(input.includes('registered'), 'watch confirms delegation before final answer')
  return { text: 'REGISTERED_AND_YIELDED' }
}
let scriptError
const model = await startResponsesModel((body) => {
  try {
    return respond(body)
  } catch (error) {
    // 假接口的断言留到主流程抛出，让 finally 始终收掉隔离进程。
    scriptError = error
    return { text: 'FIXTURE_FAILED' }
  }
})
writeFileSync(
  join(dirs.codex, 'config.toml'),
  `${codexConfig(model.baseUrl)}\n[features]\nunified_exec = true\n`,
)
const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
const deadProxy = 'http://127.0.0.1:9'
const processHandle = spawn(cli, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
  cwd: dirs.work,
  env: {
    HOME: dirs.home,
    CODEX_HOME: dirs.codex,
    TMPDIR: dirs.tmp,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HTTP_PROXY: deadProxy,
    HTTPS_PROXY: deadProxy,
    ALL_PROXY: deadProxy,
    NO_PROXY: 'localhost,127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stderr = ''
processHandle.stderr.on('data', (data) => {
  stderr += data
})
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const connect = async (handlers) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const opened = await new Promise((resolve) => {
      ws.once('open', () => resolve(true))
      ws.once('error', () => resolve(false))
    })
    if (!opened) {
      await pause(50)
      continue
    }
    ws.on('message', (data) => handlers.message(data.toString()))
    ws.on('close', () => handlers.close('native closed'))
    return { send: (raw) => ws.send(raw), close: () => ws.close() }
  }
  throw new Error(`isolated native app-server did not start: ${stderr}`)
}
const device = new DeviceServer({
  stateDir: dirs.device,
  upstreams: [{ id: 'codex', native: true, connect }],
  importExisting: false,
  wrapUp: false,
  wrapUpReminder: false,
})
device.titles.setEnabled('codex', false)
let client = new TestClient(device)
const legacy = new TestClient(device)
try {
  await client.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake'])
  await legacy.initialize(['harness', 'backgroundTasks'])
  const { thread } = await client.call('thread/start', {
    harness: 'codex',
    cwd: dirs.work,
    model: 'gpt-5.3-codex',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  const { turn } = await client.call('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Run the finite background fixture.' }],
  })
  await client.waitFor(
    (frame) => frame.method === 'turn/completed' && frame.params.turn.id === turn.id,
    15000,
  )
  assert.ifError(scriptError)
  const task = (
    await client.call('thread/read', { threadId: thread.id, includeTurns: true })
  ).thread.litchBackground.tasks.find((t) => t.litchWake === 'watching')
  assert.ok(task, 'registered task visible before completion')
  await legacy.call('thread/resume', { threadId: thread.id })
  assert.ok(!JSON.stringify(legacy.notifications).includes('litchWake'))
  client.close()
  legacy.close()
  for (let i = 0; i < 200 && !continued; i++) await pause(50)
  assert.ifError(scriptError)
  assert.ok(continued, 'all UI clients disconnected; device still delivers completion')
  await pause(200)
  client = new TestClient(device)
  await client.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake'])
  const resumed = await client.call('thread/resume', { threadId: thread.id })
  const automatic = resumed.thread.turns.find((t) => t.litchOrigin === 'backgroundTask')
  assert.ok(automatic, 'origin survives history read')
  assert.ok(
    automatic.items.some(
      (i) => i.type === 'functionCallOutput' && i.namespace === 'litch_background',
    ),
  )
  assert.ok(
    automatic.items.some(
      (i) => i.type === 'agentMessage' && i.text === 'BACKGROUND_RESULT_HANDLED',
    ),
  )
  assert.equal(
    samples.length,
    4,
    'one command, one registration, one final answer, one continuation',
  )
  assert.ok(JSON.stringify(samples.at(-1).input).includes('WAKE_NATIVE_RESULT'))
  assert.ok(JSON.stringify(samples.at(-1).input).includes('\\"exitCode\\":7'))
  const page = await client.call('thread/turns/list', { threadId: thread.id })
  assert.ok(
    page.data.some((t) => t.litchOrigin === 'backgroundTask'),
    'paginated history retains origin',
  )
  const ordinary = new TestClient(device)
  try {
    await ordinary.initialize(['harness'])
    const plain = await ordinary.call('thread/turns/list', { threadId: thread.id })
    assert.ok(
      !JSON.stringify(plain).includes('litchOrigin'),
      'undeclared peer sees standard turns only',
    )
  } finally {
    ordinary.close()
  }
  await device.close()
  const restarted = new DeviceServer({
    stateDir: dirs.device,
    upstreams: [{ id: 'codex', native: true, connect }],
    importExisting: false,
    wrapUp: false,
    wrapUpReminder: false,
  })
  const read = new TestClient(restarted)
  try {
    await read.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake'])
    const history = await read.call('thread/resume', { threadId: thread.id })
    assert.ok(history.thread.turns.some((t) => t.litchOrigin === 'backgroundTask'))
    await pause(500)
    assert.equal(samples.length, 4, 'restart never replays the completion')
  } finally {
    read.close()
    await restarted.close()
  }
  console.log(
    'PASS native background continuation: explicit watch, no UI clients, exit output, origin persistence, restart does not replay',
  )
} finally {
  client.close()
  legacy.close()
  await device.close()
  model.close()
  processHandle.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => processHandle.once('exit', resolve)),
    pause(3000).then(() => {
      if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
    }),
  ])
  // 只清理本脚本用 mkdtemp 创建的隔离目录。
  rmSync(root, { recursive: true, force: true })
}
