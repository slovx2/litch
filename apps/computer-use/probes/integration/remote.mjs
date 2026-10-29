// 真实 SSH 设备→clientTools→本机原生助手；假模型仅生成约定动作，不替换工具执行器。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createAutomationPreviewHost,
  createClientToolHost,
  createComputerExecutor,
  createCore,
  MacLauncher,
  reduceSession,
  sshOpener,
} from '../../.artifacts/integration/remote-driver.mjs'

const fixture = process.argv[2],
  root = process.argv[3]
if (!fixture?.startsWith('/tmp/litch-cu-') || !root?.startsWith('/tmp/litch-cu-'))
  throw Error('需要隔离目录')
if (!process.env.LITCH_SSH_CONFIG || !process.env.LITCH_REMOTE_ADAPTER)
  throw Error('需要隔离远程入口')
mkdirSync(root, { recursive: true })
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const fixtureName = process.env.LITCH_CU_REMOTE_TARGET === 'electron' ? 'electron' : 'appkit'
const bundle =
  fixtureName === 'electron' ? 'com.github.Electron' : 'io.github.slovx2.litch.background-fixture'
const state = (name) => read(join(fixture, name, 'state.json'))
async function until(fn, label, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = fn()
    if (value) return value
    await delay(30)
  }
  throw Error(`等待超时: ${label}`)
}
const report = { checks: [], calls: [], events: [], permissions: null, success: false }
let client, awake, core, host, preview, transport
const deviceId = 'cu-remote-fixture',
  target = { kind: 'alias', alias: process.env.LITCH_CU_REMOTE_ALIAS }
if (!target.alias || !process.env.LITCH_CU_REMOTE_CWD) throw Error('需要远程别名和隔离目录')
const directory = join(root, 'helper')
const audit = () => read(join(directory, 'foreground.json'))
function idle() {
  const a = audit()
  assert.ok(a.idle >= 2 && Date.now() / 1000 - a.sampledAt < 0.5, '用户活动或观察过期')
  assert.notEqual(a.frontBundle, 'com.apple.loginwindow')
}
async function command(name, action) {
  idle()
  process.kill(state(name).pid, 0)
  const id = randomUUID(),
    path = join(fixture, name, 'command.json')
  writeFileSync(`${path}.tmp`, JSON.stringify({ id, action }))
  renameSync(`${path}.tmp`, path)
  await until(() => state(name).commandID === id, '夹具命令')
  await delay(100)
}
try {
  const launcher = new MacLauncher({
    appPath: resolve('apps/computer-use/.artifacts/integration/Litch Background Input Probe.app'),
    directory,
    version: null,
    async launch(path, env) {
      execFileSync('open', [
        '-n',
        '-g',
        ...Object.entries({
          ...env,
          ...(process.env.LITCH_CU_PROBE_SHARE_PREVIEW === '1'
            ? { LITCH_CU_PROBE_SHARE_PREVIEW: '1' }
            : {}),
          HOME: join(root, 'home'),
          CODEX_HOME: join(root, 'codex'),
        }).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        path,
      ])
    },
  })
  client = await launcher.establish('zh-CN', console.log)
  awake = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(client.hello.pid)], {
    stdio: 'ignore',
  })
  report.permissions = await client.request('permissions')
  report.diagnostics = await client.request('diagnostics')
  assert.equal(report.permissions.accessibility, true)
  assert.equal(report.permissions.screenRecording, true)
  assert.equal(report.diagnostics.responsibleIsSelf, true)
  await delay(700)
  idle()
  report.capability = await client.request('backgroundCapabilities')
  const helper = {
    client: async () => client,
    connected: client,
    restart: async () => {
      throw Error('本轮权限缺失，不重启掩盖')
    },
  }
  const frames = new Map(),
    lastFrame = new Map(),
    views = new Map()
  preview = createAutomationPreviewHost(helper, (view, owner) => {
    views.set(owner.sessionId, view)
    if (view?.frame) {
      const frameId = `${view.frame.streamId}:${view.frame.seq}`
      if (lastFrame.get(owner.sessionId) === frameId) return
      lastFrame.set(owner.sessionId, frameId)
      frames.set(owner.sessionId, (frames.get(owner.sessionId) ?? 0) + 1)
      writeFileSync(join(root, 'preview.jpg'), Buffer.from(view.frame.data, 'base64'))
      void preview
        .control({ ...owner, action: 'ack', streamId: view.frame.streamId, seq: view.frame.seq })
        .catch(() => {})
    }
  })
  client.events.onAutomation = (n) => {
    report.events.push({
      ...n,
      data: n.data ? `jpeg:${n.data.length}` : undefined,
      receivedAt: Date.now(),
    })
    preview.receive(n)
  }
  const executor = createComputerExecutor({
    helper,
    onInvocation: (invocation, session) => preview.register(invocation, session),
  })
  let toCore, device, sessionId, view
  let abortObserved = 0
  host = createClientToolHost(
    [
      {
        namespace: executor.namespace,
        turnEnded: (t) => executor.turnEnded(t),
        async call(invocation, context) {
          idle()
          assert.equal(invocation.device.kind, 'ssh')
          assert.equal(invocation.device.id, deviceId)
          assert.equal(invocation.arguments.app, bundle)
          process.kill(state(fixtureName).pid, 0)
          const call = {
            tool: invocation.tool,
            sessionId: invocation.threadId,
            startedAt: Date.now(),
          }
          report.calls.push(call)
          context.signal.addEventListener(
            'abort',
            () => {
              abortObserved++
              call.abortedAt = Date.now()
            },
            { once: true },
          )
          const result = await executor.call(invocation, context)
          call.endedAt = Date.now()
          call.success = result.success
          call.result = result.contentItems
            ?.filter((x) => x.type === 'inputText')
            .map((x) => x.text)
            .join('\n')
          if (invocation.tool === 'click' && process.env.LITCH_CU_SYSTEM_SCREENSHOT === '1') {
            const panel = audit()
            assert.equal(panel.pid, client.hello.pid)
            assert.ok(panel.previewWindowID > 0)
            try {
              execFileSync('/usr/sbin/screencapture', [
                '-x',
                '-l',
                String(panel.previewWindowID),
                join(root, 'preview-system.png'),
              ])
              report.systemScreenshot = 'captured'
            } catch (error) {
              report.systemScreenshot = String(error)
            }
          }
          return result
        },
      },
    ],
    (m) => queueMicrotask(() => toCore?.(structuredClone(m))),
  )
  core = createCore({
    version: '0.25.0',
    clock: {
      now: Date.now,
      setTimer(fn, ms) {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      },
    },
    log: (line) => {
      if (process.env.LITCH_CHECK_DEBUG) console.error(line)
    },
    clientTools: {
      namespaces: () => host.namespaces(),
      post: (m) => queueMicrotask(() => host.handle(structuredClone(m))),
      listen: (h) => {
        toCore = h
      },
    },
    devices: [
      {
        id: deviceId,
        name: target.alias,
        host: target.alias,
        kind: 'ssh',
        target,
        wire: 'orange',
        open: async (...args) => {
          transport = await sshOpener(target)(...args)
          return transport
        },
      },
    ],
  })
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (d) => {
        device = d.devices.find((x) => x.id === deviceId)
      },
      delta: (ops) => {
        for (const op of ops)
          if (op.op === 'device.upsert' && op.device.id === deviceId) device = op.device
      },
      error: console.error,
    },
  )
  core.start()
  await until(() => device?.connection === 'online', '远程设备', 60000)
  const signal = new AbortController().signal
  await core.command('device.tools.set', { deviceId, computer: true }, signal)
  const base = { app: bundle }
  const step = (tool, args = {}) => ({
    namespace: 'litch_computer',
    tool,
    args: { ...base, ...args },
  })
  let off
  async function start(steps) {
    off?.()
    view = null
    const result = await core.command(
      'session.create',
      {
        deviceId,
        harness: 'pi',
        cwd: process.env.LITCH_CU_REMOTE_CWD,
        text: `LITCH_TOOL_PLAN ${JSON.stringify(steps)}`,
      },
      signal,
    )
    sessionId = result.sessionId
    off = core.subscribe(
      { kind: 'session', deviceId, sessionId },
      {
        snapshot: (d) => {
          view = structuredClone(d)
        },
        delta: (ops) => {
          for (const op of ops) if (view) reduceSession(view, structuredClone(op))
        },
        error: console.error,
      },
    )
    await preview.control({ deviceId, sessionId, action: 'show' })
    return sessionId
  }
  for (const action of ['reset', 'focusText', 'activate']) await command(fixtureName, action)
  await command('guard', 'activate')
  const guard = state('guard'),
    original = audit()
  // 先从本机只读快照取得尺寸，远程的第一个工具仍是真 get_app_state。
  const shot = await client.request('getAppState', { session: 'geometry', app: base.app })
  await client.request('turnEnded', { session: 'geometry' })
  const p = (name) => {
    const s = state(fixtureName),
      v = s.points[name]
    return {
      x: ((v.x - s.frame.x) * shot.screenshot.width) / s.frame.width,
      y: ((v.y - s.frame.y) * shot.screenshot.height) / s.frame.height,
    }
  }
  const r1 = await start([
    step('get_app_state'),
    step('type_text', { text: '远程abc中文' }),
    step('click', p('button')),
    step('scroll', { ...p('scroll'), direction: 'down', amount: 3 }),
  ])
  await until(() => views.get(r1)?.surface, '预览 surface')
  await until(() => frames.get(r1) > 0, '本机预览首帧')
  if (process.env.LITCH_CU_REMOTE_PIN !== '0') {
    await preview.control({ deviceId, sessionId: r1, action: 'pin' })
    await delay(350)
    writeFileSync(join(directory, 'preview-snapshot.request'), randomUUID())
    await until(() => existsSync(join(directory, 'preview-panel.png')), '原生 PiP 内容视图')
  }
  await until(
    () =>
      view &&
      Object.values(view.items).some(
        (x) => x.kind === 'agentMessage' && x.text.includes('LITCH_REMOTE_DONE'),
      ),
    '远程工具完成',
    60000,
  )
  assert.equal(state(fixtureName).text, '远程abc中文')
  assert.equal(state(fixtureName).clicks, 1)
  assert.ok(state(fixtureName).scrollY > 0)
  assert.equal(state('guard').text, guard.text)
  assert.equal(audit().frontPid, guard.pid)
  assert.equal(audit().cursorX, original.cursorX)
  assert.equal(audit().cursorY, original.cursorY)
  assert.ok(report.calls.filter((c) => c.sessionId === r1).every((c) => c.success))
  report.checks.push({
    name: 'R1',
    target: fixtureName,
    observed: state(fixtureName),
    sessionId: r1,
    frames: frames.get(r1),
    background: !report.events.some(
      (e) => e.session === `${deviceId}/${r1}` && e.status === 'foreground',
    ),
  })
  console.log('PASS R1 background / Chinese / click / scroll / local PiP')
  // 长文本使取消/断线发生在原生动作执行中；读取真实控件确认停止，不只看协议回包。
  for (const mode of ['cancel', 'disconnect']) {
    for (const action of ['reset', 'focusText', 'activate']) await command(fixtureName, action)
    await command('guard', 'activate')
    const id = await start([
      step('get_app_state'),
      step('type_text', { text: '中文abcdef'.repeat(500) }),
    ])
    await until(() => state(fixtureName).text.length > 5, '长文本开始')
    const at = Date.now(),
      before = abortObserved
    if (mode === 'cancel')
      await core.command('session.interrupt', { deviceId, sessionId: id }, signal)
    else transport.close()
    await until(() => abortObserved > before, '取消已到本机')
    await delay(500)
    const stopped = state(fixtureName).text
    await delay(700)
    assert.equal(state(fixtureName).text, stopped)
    assert.ok(stopped.length < 4000)
    assert.equal(state('guard').text, guard.text)
    report.checks.push({
      name: mode,
      sessionId: id,
      elapsedMs: Date.now() - at,
      cancelDeliveryMs: report.calls.find((c) => c.sessionId === id && c.abortedAt)?.abortedAt - at,
      characters: stopped.length,
    })
    console.log(`PASS ${mode}: ${stopped.length} characters, stable`)
  }
  report.success = true
} catch (error) {
  report.error = String(error)
  console.error(error)
  process.exitCode = 1
} finally {
  core?.stop()
  host?.reset()
  preview?.disconnected(true)
  if (client) {
    await client.request('shutdown').catch(() => {})
    client.close()
  }
  if (awake) {
    awake.kill('SIGTERM')
    await delay(200)
    report.caffeinate = {
      pid: awake.pid,
      ended: awake.exitCode !== null || awake.signalCode !== null,
    }
  }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify({
      checks: report.checks.map(({ observed, ...check }) => check),
      success: report.success,
      error: report.error,
      caffeinate: report.caffeinate,
    }),
  )
}

// 核心的退场异步计时器不延长验收占用；所有本轮外部资源已在 finally 结束。
process.exit(process.exitCode ?? 0)
