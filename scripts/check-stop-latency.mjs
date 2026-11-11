// 真 Claude / Codex + 隔离设备 + 隐藏 Electron。先 client:build，再运行。
// CHA_CLAUDE_CLI 必须指向隔离 CLI；模型全部是回环夹具，不用账号。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { startManagerFixture, until } from './client-fixture-manager-check.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const cleanup = []
const events = []
const output = join(repo, '.artifacts/stop-latency')
mkdirSync(output, { recursive: true })
let log = ''

async function probe(cwd) {
  const wait = async (read, label, timeout = 90000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = read()
      if (value) return value
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`超时 ${label}：${document.body.innerText.slice(-4000)}`)
  }
  const times = []
  const original = MessagePort.prototype.postMessage
  MessagePort.prototype.postMessage = function (frame, ...args) {
    if (frame?.t === 'cmd')
      times.push({ stage: 'client-command', at: Date.now(), name: frame.name })
    return original.call(this, frame, ...args)
  }
  const port = await new Promise((resolve) => {
    const listener = (event) => {
      if (event.data?.type !== 'litch:core-port' || !event.ports[0]) return
      window.removeEventListener('message', listener)
      resolve(event.ports[0])
    }
    window.addEventListener('message', listener)
    window.litchShell.requestCorePort()
  })
  let id = 0
  let app
  const pending = new Map()
  port.onmessage = ({ data }) => {
    if (data.t === 'snap') app = data.data
    if (data.t === 'delta')
      for (const op of data.ops)
        if (op.op === 'device.upsert')
          app.devices = [...app.devices.filter((d) => d.id !== op.device.id), op.device]
    if (data.t === 'res') {
      const request = pending.get(data.id)
      pending.delete(data.id)
      if (data.ok) request?.resolve(data.result)
      else request?.reject(new Error(JSON.stringify(data.error)))
    }
  }
  port.start()
  port.postMessage({ t: 'sub', id: 1, topic: { kind: 'app' } })
  await wait(
    () =>
      app?.devices?.some(
        (d) =>
          d.id === 'local' && d.harnesses?.some((h) => h.id === 'codex' && h.state === 'ready'),
      ),
    '设备',
  )
  const command = (name, params) =>
    new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject })
      port.postMessage({ t: 'cmd', id: next, name, params })
    })
  const results = []
  for (const harness of ['claude-code', 'codex']) {
    for (const kind of ['文字', '工具']) {
      const text = `中断耗时${kind} ${harness}`
      const { sessionId } = await command('session.create', {
        deviceId: 'local',
        harness,
        cwd,
        text,
        settings: { permission: ':danger-full-access' },
      })
      const row = await wait(
        () => [...document.querySelectorAll('.ss-row')].find((e) => e.textContent.includes(text)),
        '会话行',
      )
      row.click()
      await wait(() => document.querySelector('.send.stop'), '停止按钮')
      await wait(
        () =>
          kind === '文字'
            ? document.body.innerText.includes('持续输出用于中断测量')
            : document.body.innerText.includes('litch-stop-work'),
        '真实执行',
      )
      await new Promise((r) => setTimeout(r, 300))
      const at = Date.now()
      times.push({ stage: 'click-stop', at, harness, kind, sessionId })
      document.querySelector('.send.stop').click()
      await wait(() => !document.querySelector('.send.stop'), '回合终态')
      const ended = Date.now()
      const edit = await wait(() => document.querySelector('.umsg .act-edit'), '编辑入口')
      edit.click()
      const input = await wait(() => document.querySelector('.umsg-edit'), '编辑输入')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
        input,
        `编辑完成 ${harness} ${kind}`,
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
      const editAt = Date.now()
      times.push({ stage: 'click-edit', at: editAt, harness, kind, sessionId })
      document.querySelector('.umsg-edit-bar .primary').click()
      await wait(() => !document.querySelector('.umsg-edit'), '编辑应用')
      results.push({
        harness,
        kind,
        sessionId,
        click: at,
        idle: ended,
        stopMs: ended - at,
        editClick: editAt,
        editMs: Date.now() - editAt,
      })
      await wait(() => !document.querySelector('.send.stop'), '编辑后结束')
    }
  }
  return { results, times }
}

try {
  assert.ok(
    process.env.CHA_CLAUDE_CLI && process.env.CHA_CODEX_CLI,
    '请指定隔离的 Claude 和 Codex CLI',
  )
  const fixture = await startManagerFixture(
    { after: (fn) => cleanup.push(fn) },
    {
      CHA_CLAUDE_CLI: process.env.CHA_CLAUDE_CLI,
      CHA_CODEX_CLI: process.env.CHA_CODEX_CLI,
    },
  )
  cleanup.push(() => {
    const traces = globSync(join(fixture.root, 'h/logs/*/*.jsonl')).flatMap((file) =>
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .flatMap((line) => {
          try {
            const event = JSON.parse(line)
            if (
              !event.method ||
              !/turn\/(interrupt|completed)|thread\/(revert|resume|turns\/list)/.test(event.method)
            )
              return []
            return [
              {
                file: file.slice(fixture.root.length),
                ts: event.ts,
                event: event.event,
                method: event.method,
                ms: event.ms,
                id: event.id,
                threadId: event.threadId ?? event.params?.threadId,
                ok: event.ok,
              },
            ]
          } catch {
            return []
          }
        }),
    )
    writeFileSync(join(output, 'engine-trace.json'), JSON.stringify(traces, null, 2))
  })
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const socket = join(fixture.root, 'measure.sock')
  wss.on('connection', (down) => {
    const up = new WebSocket('ws://localhost/', {
      createConnection: () => net.createConnection(fixture.socket),
    })
    const queued = []
    const requests = new Map()
    up.on('open', () => {
      for (const raw of queued) up.send(raw)
    })
    down.on('message', (raw) => {
      const frame = JSON.parse(raw)
      if (frame.method) {
        requests.set(frame.id, frame.method)
        events.push({
          stage: 'device-ingress',
          at: Date.now(),
          method: frame.method,
          threadId: frame.params?.threadId,
        })
      }
      if (up.readyState === WebSocket.OPEN) up.send(raw.toString())
      else queued.push(raw.toString())
    })
    up.on('message', (raw) => {
      const frame = JSON.parse(raw)
      events.push({
        stage: frame.method ? 'notification' : 'device-response',
        at: Date.now(),
        method: frame.method ?? requests.get(frame.id),
        threadId: frame.params?.threadId,
      })
      if (down.readyState === WebSocket.OPEN) down.send(raw.toString())
    })
    down.on('close', () => up.close())
    up.on('error', (error) => {
      log += String(error)
      down.close()
    })
  })
  await new Promise((resolve) => server.listen(socket, resolve))
  cleanup.push(() => {
    for (const client of wss.clients) client.terminate()
    wss.close()
    server.close()
  })
  const home = join(fixture.root, 'desktop-home')
  const profile = join(fixture.root, 'desktop-profile')
  mkdirSync(home)
  mkdirSync(profile)
  writeFileSync(join(profile, 'devices.json'), JSON.stringify({ localWire: null, remotes: [] }))
  const bootstrap = join(fixture.root, 'desktop.mjs')
  writeFileSync(
    bootstrap,
    `
import { app } from 'electron';
process.on('SIGTERM', () => app.quit());
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}; app.dock?.hide();
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', () => {
    window.webContents.executeJavaScript(${JSON.stringify(`(${probe.toString()})(${JSON.stringify(fixture.engines.cwd)})`)}, true)
      .then(result => console.log('STOP_RESULT ' + JSON.stringify(result)))
      .catch(error => console.log('STOP_ERROR ' + error.stack));
  });
});
await import(${JSON.stringify(pathToFileURL(join(repo, 'apps/desktop/dist/main.mjs')).href)});
`,
  )
  const desktop = spawn(require('electron'), withChromiumTestArgs([bootstrap]), {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, 'codex'),
      TMPDIR: fixture.root,
      LITCH_PROFILE: profile,
      LITCH_ENTRY: socket,
      LITCH_LANG: 'zh-CN',
    },
  })
  cleanup.push(async () => {
    if (desktop.exitCode !== null) return
    const done = new Promise((resolve) => desktop.once('exit', resolve))
    desktop.kill('SIGTERM')
    await done
  })
  desktop.stdout.on('data', (raw) => {
    log += raw
  })
  desktop.stderr.on('data', (raw) => {
    log += raw
  })
  await until(
    '桌面测量',
    () => log,
    (value) => /STOP_(RESULT|ERROR) /.test(value),
    300000,
  )
  const result = log.split('\n').find((line) => line.startsWith('STOP_RESULT '))
  assert.ok(result, log)
  const report = { ...JSON.parse(result.slice(12)), events }
  writeFileSync(
    join(output, `${process.argv.includes('--baseline') ? 'baseline' : 'fixed'}.json`),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report.results, null, 2))
} finally {
  writeFileSync(join(output, 'desktop.log'), log)
  for (const close of cleanup.reverse()) await close()
}
