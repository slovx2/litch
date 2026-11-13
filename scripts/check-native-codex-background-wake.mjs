// 真原生 Codex + 真设备进程 + 回环假 Responses：验证登记、释放回合、离线完成与接续。
// 先 npm run build --prefix packages/device；CHA_CODEX_CLI 必须指隔离准备的官方 CLI。
// 环境从零构造，绝不读取个人模型凭据或真实 HOME/CODEX_HOME。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { resolveAutomationTools } from '../packages/device/dist/shared/src/automation-tools.mjs'
import { codexConfig, startResponsesModel } from './client-fixture-responses.mjs'

// --child-entry=start|accept|manager-line 同时验收派子会话的真实工具调用链。
const entry = process.argv.find((arg) => arg.startsWith('--child-entry='))?.split('=')[1]
const activeDelivery = process.argv.includes('--active')
// 真正等待固定时长，用于核验回合释放后原生命令仍存活并触发接续；默认保留原来的可控释放夹具。
const sleepSeconds = Number(
  process.argv.find((arg) => arg.startsWith('--sleep='))?.split('=')[1] ?? 0,
)
if (!Number.isInteger(sleepSeconds) || sleepSeconds < 0 || sleepSeconds > 60)
  throw new Error('--sleep must be an integer from 0 to 60')
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
const completedTurns = new Set()
const samples = []
let commandCompletedAt
let modelReceivedAt
let completionReceivedAt
let backgroundSentAt
const steered = new Set()
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
    modelReceivedAt = Date.now()
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
          cmd: (sleepSeconds
            ? `sleep ${sleepSeconds}; echo WAKE_NATIVE_RESULT; exit 7`
            : 'while [ ! -f release-background ]; do sleep 0.1; done; echo WAKE_NATIVE_RESULT; exit 7'
          ).replace(
            'exit 7',
            `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync("command-exit-at", String(Date.now()))'; exit 7`,
          ),
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
  if (stage === 3) {
    const output = JSON.stringify(
      body.input.findLast((item) => item.type === 'function_call_output')?.output,
    )
    assert.match(output, /registered/, 'watch confirms delegation before final answer')
    assert.doesNotMatch(output, /\[litch:/, 'watch 必须成功，不能把工具错误当作已登记')
  }
  // 活动夹具连续做独立工作；完成插话应在下一次采样可见，不能等所有工作做完。
  if (activeDelivery && stage < 43)
    return {
      call: {
        namespace: 'functions',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'sleep 0.1', yield_time_ms: 1000 }),
      },
    }
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
    ws.on('message', (data) => {
      const raw = data.toString()
      const frame = JSON.parse(raw)
      if (frame.method === 'turn/completed') completedTurns.add(frame.params.threadId)
      if (
        frame.method === 'item/completed' &&
        frame.params.item?.type === 'commandExecution' &&
        frame.params.item.command?.includes('WAKE_NATIVE_RESULT')
      ) {
        commandCompletedAt ??= frame.params.completedAtMs ?? Date.now()
        completionReceivedAt ??= Date.now()
      }
      if (frame.id != null && !frame.method && steered.has(frame.id)) {
        assert.ok(!frame.error, JSON.stringify(frame.error))
      }
      handlers.message(raw)
    })
    ws.on('close', () => handlers.close('native closed'))
    return {
      send: (raw) => {
        const frame = JSON.parse(raw)
        if (frame.method === 'thread/start') sentStarts.push(frame.params)
        if (
          frame.method === 'turn/steer' &&
          frame.params.clientUserMessageId?.startsWith('litch-background-')
        ) {
          backgroundSentAt ??= Date.now()
          steered.add(frame.id)
        }
        ws.send(raw)
      },
      close: () => {
        // 设备关闭后不能再把已排队的原生消息交给已释放的数据库。
        ws.removeAllListeners('message')
        ws.close()
      },
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
      // 沿用隔离配置里的 fixture-gate，不依赖真实模型目录中的某个固定名字。
      model: null,
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
      model: 'fixture-gate',
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
  // 从原生连接记录完成事件，避免子会话结束早于客户端补订阅；首回合完成前 rollout 可能还是空文件。
  for (let i = 0; i < 400; i++) {
    assert.ifError(scriptError)
    if (activeDelivery ? samples.length >= 3 : completedTurns.has(thread.id)) break
    if (i === 399) throw new Error(`回合未结束：${thread.id}; samples=${samples.length}; ${stderr}`)
    await pause(50)
  }
  const history = await client.call('thread/read', { threadId: thread.id, includeTurns: true })
  assert.ok(
    history.thread.turns.some(
      (turn) => turn.status === (activeDelivery ? 'inProgress' : 'completed'),
    ),
    '原生历史确认首回合状态',
  )
  assert.ifError(scriptError)
  // 本夹具直接建 DeviceServer，不走启动器的 skill 安装；原生发现为空时必须使用 guide 短表。
  const discovered = await client.call('skills/list', {
    harness: 'codex',
    cwds: [dirs.work],
    forceReload: true,
  })
  assert.ok(
    !discovered.data.some((row) =>
      row.skills.some((skill) =>
        ['litch-browser-automation', 'litch-computer-automation'].includes(skill.name),
      ),
    ),
    '未安装 skill 的隔离 HOME 不应发现个人自动化 skill',
  )
  const registeredTools = device.sessionTree.store.tools(thread.id)
  assert.deepEqual(
    withDeveloperInstructions(
      {
        dynamicTools: resolveAutomationTools(registeredTools, 'codex', { visiblePaths: new Set() }),
      },
      null,
    ).dynamicTools,
    sentStarts.at(-1).dynamicTools,
    '登记清单经 skill/guide 投影并提取开发者指令后，必须与实际发送的清单逐字一致',
  )
  const browser = sentStarts.at(-1).dynamicTools.find((tool) => tool.name === 'litch_browser')
  assert.match(browser.description, /Before use, read litch_automation\.guide\(topic: "browser"\)/)
  assert.ok(browser.tools.every((tool) => tool.description.includes('litch_automation.guide')))
  assert.ok(sentStarts.at(-1).dynamicTools.some((tool) => tool.name === 'litch_automation'))
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
  for (let i = 0; i < (sleepSeconds + 15) * 20 && !continued; i++) await pause(50)
  assert.ifError(scriptError)
  assert.ok(continued, 'all UI clients disconnected; device still delivers completion')
  const processExitMarkerAt = Number(readFileSync(join(dirs.work, 'command-exit-at'), 'utf8'))
  console.log(
    JSON.stringify({
      mode: activeDelivery ? 'active' : 'idle',
      phase: 'received',
      processExitMarkerAt,
      commandCompletedAt,
      completionReceivedAt,
      modelReceivedAt,
      modelLatencyMs: modelReceivedAt - processExitMarkerAt,
    }),
  )
  await pause(200)
  client = new TestClient(device)
  await client.initialize(['harness', 'backgroundTasks', 'nativeBackgroundWake'])
  const resumed = await client.call('thread/resume', { threadId: thread.id })
  const automatic = resumed.thread.turns.find((t) => t.litchOrigin === 'backgroundTask')
  if (activeDelivery) {
    assert.equal(automatic, undefined, '后台插话不能把整个用户回合改成后台回合')
    const messages = resumed.thread.turns
      .flatMap((t) => t.items)
      .filter((i) => i.litchOrigin === 'backgroundTask')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, 'userMessage')
    assert.match(messages[0].content[0].text, /^<litch-background-completed>/)
  } else {
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
  }
  if (activeDelivery)
    assert.ok(samples.length >= 4 && samples.length < 43, '活动回合在独立工作结束前收到结果')
  else
    assert.equal(
      samples.length,
      4,
      'one command, one registration, one final answer, one continuation',
    )
  assert.ok(JSON.stringify(samples.at(-1).input).includes('WAKE_NATIVE_RESULT'))
  assert.ok(/exitCode.{0,3}:7/.test(JSON.stringify(samples.at(-1).input)))
  const page = await client.call('thread/turns/list', {
    threadId: thread.id,
    ...(activeDelivery ? { itemsView: 'full' } : {}),
  })
  assert.ok(
    page.data.some((t) =>
      activeDelivery
        ? t.items.some((i) => i.litchOrigin === 'backgroundTask')
        : t.litchOrigin === 'backgroundTask',
    ),
    'paginated history retains origin',
  )
  const ordinary = new TestClient(device)
  try {
    await ordinary.initialize(['harness'])
    const plain = await ordinary.call('thread/turns/list', {
      threadId: thread.id,
      ...(activeDelivery ? { itemsView: 'full' } : {}),
    })
    assert.ok(
      !JSON.stringify(plain).includes('litchOrigin'),
      'undeclared peer sees standard turns only',
    )
  } finally {
    ordinary.close()
  }
  const sampledBeforeRestart = samples.length
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
    assert.ok(
      history.thread.turns.some((t) =>
        activeDelivery
          ? t.items.some((i) => i.litchOrigin === 'backgroundTask')
          : t.litchOrigin === 'backgroundTask',
      ),
    )
    await pause(500)
    assert.equal(samples.length, sampledBeforeRestart, 'restart never replays the completion')
  } finally {
    read.close()
    await restarted.close()
  }
  assert.ok(commandCompletedAt && modelReceivedAt && completionReceivedAt)
  assert.ok(modelReceivedAt - processExitMarkerAt < 3000, '命令结束后三秒内假模型必须收到结果')
  assert.equal(steered.size, activeDelivery ? 1 : 0)
  console.log(
    JSON.stringify({
      mode: activeDelivery ? 'active' : 'idle',
      processExitMarkerAt,
      backgroundSentAt,
      commandCompletedAt,
      completionReceivedAt,
      modelReceivedAt,
      eventLatencyMs: completionReceivedAt - commandCompletedAt,
      modelLatencyMs: modelReceivedAt - processExitMarkerAt,
    }),
  )
  console.log(
    `PASS native background continuation (${entry ?? 'client'}, sleep=${sleepSeconds}s): final tools, explicit watch, no UI clients, exit output, origin persistence, restart does not replay`,
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
