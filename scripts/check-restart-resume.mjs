// 隔离的 Go 常驻服务 + 设备进程 + 真实 Claude CLI，模型仅回环假服务。
// 先构建 claude、device 与 Go CLI；CHA_CLAUDE_CLI 必须指向隔离 CLI。
// PATH=/opt/homebrew/opt/node@24/bin:$PATH CHA_CLAUDE_CLI=/isolated/claude node scripts/check-restart-resume.mjs
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import { MockLLM } from '../packages/claude/dist/claude/test/fixtures/mock-llm.mjs'
import { protocolEnv } from '../packages/claude/dist/claude/test/fixtures/protocol-client.mjs'
import { writeDeviceSettings } from './client-fixture-engines.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'lrr-'))
const home = join(root, 'adapter')
const model = new MockLLM()
const url = await model.start()
const env = protocolEnv(root, url, false)
const binary = join(repo, 'bin', 'codex-harness-adapter')
const common = ['--home', home, '--root', repo, '--node', process.execPath]
const execute = promisify(execFile)
const cli = (command, extra = []) =>
  execute(binary, [command, ...common, ...extra], {
    env,
    timeout: 100_000,
    maxBuffer: 2_000_000,
  })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, what) {
  const end = Date.now() + 45000
  while (Date.now() < end) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`未等到：${what}；隔离状态在 ${root}`)
}

const clients = new Set()
async function connect() {
  const ws = new WebSocket(`ws+unix://${join(home, 'device', 'device.sock')}:/`)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  clients.add(ws)
  let sequence = 0
  const pending = new Map()
  ws.on('message', (bytes) => {
    const frame = JSON.parse(bytes.toString())
    if (frame.method) return
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.error) entry.reject(new Error(JSON.stringify(frame.error)))
    else entry.resolve(frame.result)
  })
  ws.on('close', () => {
    clients.delete(ws)
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('连接关闭'))
    }
    pending.clear()
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`请求超时：${method}`))
      }, 15000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  await call('initialize', {
    clientInfo: { name: 'restart-fixture', version: '1' },
    capabilities: {
      experimentalApi: true,
      litchExtensions: ['harness', 'deviceService', 'deviceSettings', 'backgroundTasks'],
    },
  })
  ws.send(JSON.stringify({ method: 'initialized' }))
  return { call, close: () => ws.close() }
}

mkdirSync(join(root, 'claude'), { recursive: true })
writeDeviceSettings(home, {
  ...Object.fromEntries(
    ['pi', 'dsh', 'codex', 'opencode', 'gemini', 'qwen', 'acp'].map((id) => [
      `harness.${id}.enabled`,
      false,
    ]),
  ),
  'harness.claude-code.enabled': true,
  'harness.claude-code.cliPath': env.CHA_CLAUDE_CLI,
  'harness.claude-code.env': Object.entries(env)
    .filter(
      ([key]) =>
        key.startsWith('ANTHROPIC_') ||
        key.startsWith('CLAUDE_') ||
        key.startsWith('DISABLE_') ||
        key === 'CHA_CLAUDE_RUNTIME',
    )
    .map(([name, value]) => ({ name, value })),
  'sessions.wrapUp': false,
  'sessions.wrapUpReminder': false,
})

const marker = join(root, 'effect.txt')
let first, second, threadId, result
try {
  first = JSON.parse((await cli('device-start', ['--ssh=off'])).stdout)
  const old = await connect()
  await until(
    async () =>
      (await old.call('runtime/info')).harnesses.some((h) => h.id === 'claude-code' && h.available),
    'Claude 引擎就绪',
  )
  const created = await old.call('thread/start', {
    harness: 'claude-code',
    cwd: root,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  threadId = created.thread.id
  model.enqueue(() => [
    {
      type: 'tool_use',
      id: 'write-once',
      name: 'Bash',
      input: { command: `printf ONCE >> '${marker}'; /bin/sleep 30`, timeout: 60000 },
    },
  ])
  await old.call('turn/start', { threadId, input: [{ type: 'text', text: '写入一次后检查结果' }] })
  await until(() => {
    try {
      return readFileSync(marker, 'utf8') === 'ONCE'
    } catch {
      return false
    }
  }, '工具实际写入')
  model.enqueue((request) => {
    const history = JSON.stringify(request.messages)
    assert.match(history, /Automatic continuation after a planned service restart/)
    assert.match(history, /Do not blindly repeat/)
    return [{ type: 'tool_use', id: 'verify-effect', name: 'Read', input: { file_path: marker } }]
  })
  model.enqueue(() => [{ type: 'text', text: 'RESTART_RESUMED_ONCE' }])
  await cli('device-stop', ['--resume-after-restart'])
  const before = new DatabaseSync(join(home, 'device', 'device.sqlite'), { readOnly: true })
  assert.equal(
    before.prepare('SELECT state FROM restart_turns WHERE thread_id=?').get(threadId)?.state,
    'ready',
  )
  before.close()
  second = JSON.parse((await cli('device-start', ['--ssh=off'])).stdout)
  assert.notEqual(first.pid, second.pid)
  const fresh = await connect()
  await until(async () => {
    const read = await fresh.call('thread/read', { threadId, includeTurns: true })
    const last = read.thread.turns.at(-1)
    result = read
    return last?.status === 'completed' && JSON.stringify(last).includes('RESTART_RESUMED_ONCE')
  }, '原会话自动续跑完成')
  assert.equal(readFileSync(marker, 'utf8'), 'ONCE')
  assert.equal(result.thread.turns.length, 2)
  assert.equal(model.requests.length, 3)
  // 同一个服务里的单引擎 apply：服务 PID 不变，仍须在新引擎准备好后续上。
  const harnessMarker = join(root, 'harness-effect.txt')
  model.enqueue(() => [
    {
      type: 'tool_use',
      id: 'harness-write-once',
      name: 'Bash',
      input: { command: `printf ONCE >> '${harnessMarker}'; /bin/sleep 30`, timeout: 60000 },
    },
  ])
  await fresh.call('turn/start', {
    threadId,
    input: [{ type: 'text', text: '另一条独立任务，只写一次并核对' }],
  })
  await until(() => {
    try {
      return readFileSync(harnessMarker, 'utf8') === 'ONCE'
    } catch {
      return false
    }
  }, '单引擎重启前的副作用')
  model.enqueue((request) => {
    assert.match(
      JSON.stringify(request.messages.at(-1)),
      /Automatic continuation after a planned service restart/,
    )
    return [
      {
        type: 'tool_use',
        id: 'harness-verify-effect',
        name: 'Read',
        input: { file_path: harnessMarker },
      },
    ]
  })
  model.enqueue(() => [{ type: 'text', text: 'HARNESS_RESUMED_ONCE' }])
  await fresh.call('litch/device/harness/restart', { harness: 'claude-code', force: true })
  await until(async () => {
    result = await fresh.call('thread/read', { threadId, includeTurns: true })
    return (
      result.thread.turns.at(-1)?.status === 'completed' &&
      JSON.stringify(result.thread.turns.at(-1)).includes('HARNESS_RESUMED_ONCE')
    )
  }, '单引擎重启自动续跑')
  assert.equal(readFileSync(harnessMarker, 'utf8'), 'ONCE')
  assert.equal(result.thread.turns.length, 4)
  assert.equal(model.requests.length, 6)
  model.assertConsumed()
  const report = {
    root,
    cli: (await execute(env.CHA_CLAUDE_CLI, ['--version'], { env })).stdout.trim(),
    node: process.versions.node,
    threadId,
    oldPid: first.pid,
    newPid: second.pid,
    turns: result.thread.turns.map((turn) => ({ id: turn.id, status: turn.status })),
    modelRequests: model.requests.length,
    effect: readFileSync(marker, 'utf8'),
    harnessEffect: readFileSync(harnessMarker, 'utf8'),
    result: 'passed',
  }
  mkdirSync(join(repo, '.local'), { recursive: true })
  writeFileSync(join(repo, '.local', 'restart-resume-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const client of clients) client.close()
  await cli('device-stop').catch((error) => console.error(`隔离服务收尾失败：${String(error)}`))
  await model.close()
}
