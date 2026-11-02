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
import { SESSION_TOOLS } from '../packages/device/dist/protocol/src/client-tools-sessions.mjs'
import { withDeveloperInstructions } from '../packages/device/dist/protocol/src/codex-developer-instructions.mjs'
import {
  MANAGER_DEFAULT_CONTACT,
  MANAGER_DEFAULT_DISPATCH,
  MANAGER_METHOD,
} from '../packages/device/dist/protocol/src/manager.mjs'
import { codexConfig, startResponsesModel } from './client-fixture-responses.mjs'

// --child-entry=start|accept|manager-line 同时验收派子会话的真实工具调用链。
const entry = process.argv.find((arg) => arg.startsWith('--child-entry='))?.split('=')[1]
if (entry && !['start', 'accept', 'manager-line'].includes(entry))
  throw new Error(`Unknown child entry: ${entry}`)
const cli = process.env.CHA_CODEX_CLI
if (!cli) throw new Error('CHA_CODEX_CLI must point to an isolated official Codex CLI')
const root = mkdtempSync(join(tmpdir(), 'litch-native-wake-'))
const dirs = Object.fromEntries(
  ['home', 'codex', 'tmp', 'work', 'device'].map((key) => [key, join(root, key)]),
)
for (const dir of Object.values(dirs)) mkdirSync(dir)
let stage = 0
let continued = false
let parentStage = 0
const sentStarts = []
const samples = []
const respond = (body) => {
  const input = JSON.stringify(body.input)
  if (
    entry &&
    body.input.some(
      (item) =>
        item.role === 'user' &&
        item.content?.some((part) => part.text === 'PARENT_DISPATCH_FIXTURE'),
    )
  ) {
    const outputs = body.input.filter((item) => item.type === 'function_call_output')
    assert.ok(!JSON.stringify(outputs).includes('[litch:'), JSON.stringify(outputs))
    if (parentStage++ === 0)
      return {
        call: {
          namespace: 'litch_sessions',
          name: 'start',
          arguments: JSON.stringify({
            title: '后台子会话验收',
            background:
              '这是完全隔离的本机后台接续验收，使用测试专用 HOME、CODEX_HOME 和回环假模型。父会话授权新建普通 Codex 子会话，执行一个有限命令，登记任务后结束回合，等待设备投递结果。不要访问真实凭据或任何远程主机。',
            prompt: 'Run the finite background fixture.',
            kind: 'fresh',
            initiation: entry === 'accept' ? 'propose' : 'user_asked',
            worktree: false,
            wake_parent: false,
          }),
        },
      }
    if (entry === 'accept' && parentStage === 2) {
      const proposal = /"proposal_id"\s*:\s*"([^"]+)"/.exec(
        outputs.map((item) => item.output).join('\n'),
      )
      assert.ok(proposal, '父会话收到提案号')
      return {
        call: {
          namespace: 'litch_sessions',
          name: 'accept',
          arguments: JSON.stringify({ proposal_id: proposal[1] }),
        },
      }
    }
    return { text: 'PARENT_DISPATCHED' }
  }
  samples.push(body)
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
    assert.ok(
      input.includes('You must register finite commands that wait for one event and then exit'),
    )
    assert.ok(input.includes('receiving one message or email'))
    assert.ok(input.includes('waiting for a build to finish'))
    assert.ok(!input.includes('Do not register dev servers, watchers'))
    assert.ok(JSON.stringify(body.tools).includes('Register one-shot listeners'))
    return {
      call: {
        namespace: 'functions',
        name: 'exec_command',
        arguments: JSON.stringify({
          // 由验收主流程在登记完成后放行，避免机器负载让命令早于 watch 退出。
          cmd: 'while [ ! -f release-background ]; do sleep 0.1; done; echo WAKE_NATIVE_RESULT; exit 7',
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
  const output = JSON.stringify(
    body.input.findLast((item) => item.type === 'function_call_output')?.output,
  )
  assert.match(output, /registered/, 'watch confirms delegation before final answer')
  assert.doesNotMatch(output, /\[litch:/, 'watch 必须成功，不能把工具错误当作已登记')
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
    return {
      send: (raw) => {
        const frame = JSON.parse(raw)
        if (frame.method === 'thread/start') sentStarts.push(frame.params)
        ws.send(raw)
      },
      close: () => ws.close(),
    }
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
  await client.initialize([
    'harness',
    'backgroundTasks',
    'nativeBackgroundWake',
    'sessionTree',
    'clientTools',
    'litchManager',
  ])
  await legacy.initialize(['harness', 'backgroundTasks'])
  let parentId
  let thread
  if (entry === 'manager-line') {
    const created = await client.call(MANAGER_METHOD.create, {
      cwd: dirs.work,
      harness: 'codex',
      model: 'gpt-5.3-codex',
      effort: null,
      permission: ':danger-full-access',
      name: '后台验收经理',
      scope: '完成后台子会话验收',
      template: 'blank',
      rules: '',
      dispatch: { ...MANAGER_DEFAULT_DISPATCH, worktree: false },
      contact: { ...MANAGER_DEFAULT_CONTACT },
      firstTask: 'PARENT_DISPATCH_FIXTURE',
    })
    parentId = created.threadId
  } else {
    const created = await client.call('thread/start', {
      harness: 'codex',
      cwd: dirs.work,
      model: 'gpt-5.3-codex',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      historyMode: 'paginated',
      ...(entry ? { dynamicTools: [SESSION_TOOLS] } : {}),
    })
    thread = created.thread
    parentId = thread.id
    await client.call('turn/start', {
      threadId: thread.id,
      input: [
        {
          type: 'text',
          text: entry ? 'PARENT_DISPATCH_FIXTURE' : 'Run the finite background fixture.',
        },
      ],
    })
  }
  if (entry) {
    for (let i = 0; i < 300; i++) {
      assert.ifError(scriptError)
      const child = device.sessionTree.store
        .children()
        .find((row) => row.parentThreadId === parentId)
      if (child) {
        thread = { id: child.threadId }
        break
      }
      await pause(50)
    }
    assert.ok(thread && thread.id !== parentId, '父会话通过动态工具创建了子会话')
    await client.call('thread/resume', { threadId: thread.id })
  }
  // 子会话的首回合可能在客户端补订阅前结束，读原生状态同样能确认释放回合。
  for (let i = 0; i < 400; i++) {
    assert.ifError(scriptError)
    const history = await client.call('thread/read', { threadId: thread.id, includeTurns: true })
    if (history.thread.turns.some((turn) => turn.status === 'completed')) break
    if (i === 399)
      throw new Error(
        `回合未结束：${JSON.stringify(history)}; samples=${samples.length}; ${stderr}`,
      )
    await pause(50)
  }
  assert.ifError(scriptError)
  assert.deepEqual(
    withDeveloperInstructions({ dynamicTools: device.sessionTree.store.tools(thread.id) }, null)
      .dynamicTools,
    sentStarts.at(-1).dynamicTools,
    '设备登记的工具清单与实际发给原生 Codex 的清单一致（规则已提取为开发者指令）',
  )
  assert.equal(device.nativeBackground.installed(thread.id), true)
  const registered = await client.call('thread/read', { threadId: thread.id, includeTurns: true })
  const task = registered.thread.litchBackground.tasks.find((t) => t.litchWake === 'watching')
  assert.ok(
    task,
    `registered task visible before completion: ${JSON.stringify(registered)}; samples=${samples.length}`,
  )
  await legacy.call('thread/resume', { threadId: thread.id })
  assert.ok(!JSON.stringify(legacy.notifications).includes('litchWake'))
  client.close()
  legacy.close()
  writeFileSync(join(dirs.work, 'release-background'), '')
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
    `PASS native background continuation (${entry ?? 'client'}): final tools, explicit watch, no UI clients, exit output, origin persistence, restart does not replay`,
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
