// 正式隐藏桌面 + 隔离设备 + Claude 父/Codex 子 + 回环假模型，真实浏览器与 CU list_apps。
// 先构建 UI、desktop、device、claude、pi，并提供隔离 CLI 与已构建助手 LITCH_COMPUTER_USE_APP。
// 本引导直接用 webContents 驱动自己的窗口，不启用 CDP，也不接管用户的窗口或端口。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  managerClient,
  startManagerFixture,
  until,
} from '../../../scripts/client-fixture-manager-check.mjs'
import { SESSIONS_HEARD } from '../../../scripts/client-fixture-sessions.mjs'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(import.meta.url)
const cleanup = []
const t = { after: (fn) => cleanup.push(fn) }
const directory = join(
  repo,
  '.artifacts/background-tools-real',
  new Date().toISOString().replaceAll(':', '-'),
)
mkdirSync(directory, { recursive: true })
let desktop
let output = ''
let evidence

// 只通过正式核心通道建父会话，绝不订阅、恢复或在 UI 打开子会话。
async function pageStart(config) {
  const port = await new Promise((resolve) => {
    const listener = (event) => {
      if (event.data?.type !== 'litch:core-port' || !event.ports[0]) return
      window.removeEventListener('message', listener)
      resolve(event.ports[0])
    }
    window.addEventListener('message', listener)
    window.litchShell.requestCorePort()
  })
  const pending = new Map()
  let serial = 0
  let app
  port.onmessage = ({ data }) => {
    if (data.t === 'snap') app = data.data
    if (data.t === 'delta')
      for (const op of data.ops)
        if (op.op === 'device.upsert')
          app.devices = [...app.devices.filter((d) => d.id !== op.device.id), op.device]
    if (data.t !== 'res') return
    const request = pending.get(data.id)
    pending.delete(data.id)
    if (data.ok) request?.resolve(data.result)
    else request?.reject(new Error(JSON.stringify(data.error)))
  }
  port.start()
  port.postMessage({ t: 'sub', id: 1, topic: { kind: 'app' } })
  const end = Date.now() + 60_000
  while (
    !app?.devices?.some(
      (d) => d.id === 'local' && d.harnesses?.some((h) => h.id === 'codex' && h.state === 'ready'),
    )
  ) {
    if (Date.now() >= end) throw new Error(`设备未就绪：${JSON.stringify(app)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const command = (name, params) =>
    new Promise((resolve, reject) => {
      const id = ++serial
      pending.set(id, { resolve, reject })
      port.postMessage({ t: 'cmd', id, name, params })
    })
  const parent = await command('session.create', {
    deviceId: 'local',
    harness: 'claude-code',
    cwd: config.cwd,
    text: `会话：start ${JSON.stringify({
      title: '真实桌面后台工具验收',
      harness: 'codex',
      kind: 'fresh',
      initiation: 'user_asked',
      worktree: false,
      wake_parent: false,
      background:
        '这是隔离设备与隐藏桌面窗口中的后台子会话路由验收。只访问回环测试页并读取页面，然后用 Computer Use 只读列出应用；不点击、不打字、不读取用户文件、不自动处理系统授权弹窗。',
      prompt: `后台桌面验收：${config.url}`,
    })}`,
  })
  return { parentId: parent.sessionId, tools: app.devices.find((d) => d.id === 'local').tools }
}

try {
  assert.ok(
    process.env.CHA_CLAUDE_CLI && process.env.CHA_CODEX_CLI,
    '请指定隔离的 Claude、Codex CLI',
  )
  assert.ok(process.env.LITCH_COMPUTER_USE_APP, '请指定本分支构建的 CU 助手')
  const fixture = await startManagerFixture(t, {
    CHA_CLAUDE_CLI: process.env.CHA_CLAUDE_CLI,
    CHA_CODEX_CLI: process.env.CHA_CODEX_CLI,
  })
  const reader = await managerClient(t, fixture.socket)
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><title>M16 本地验收</title><h1>M16 后台浏览器真实页面</h1><p>后台子会话已读到测试页文字。</p>',
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  const url = `http://localhost:${server.address().port}/m16`
  const scratch = join(fixture.root, 'desktop-m16')
  const home = join(scratch, 'home')
  const profile = join(scratch, 'profile')
  for (const path of [home, profile]) mkdirSync(path, { recursive: true })
  writeFileSync(
    join(profile, 'devices.json'),
    JSON.stringify({
      localWire: null,
      remotes: [],
      tools: { local: { browser: true, computer: true } },
    }),
  )
  const bootstrap = join(scratch, 'bootstrap.mjs')
  writeFileSync(
    bootstrap,
    `
import { app } from 'electron';
let attached = false;
process.on('SIGTERM', () => app.quit());
app.on('browser-window-created', (_event, window) => {
  if (attached) return; attached = true;
  window.show = () => {}; app.dock?.hide();
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('did-finish-load', () => {
    console.log('M16_DESKTOP ' + JSON.stringify({ pid: process.pid, hidden: !window.isVisible(), cdp: false }));
    window.webContents.executeJavaScript(${JSON.stringify(`(${pageStart.toString()})(${JSON.stringify({ cwd: fixture.engines.cwd, url })})`)}, true)
      .then((result) => console.log('M16_PARENT ' + JSON.stringify(result)))
      .catch((error) => { console.error(error); app.exit(1); });
  });
});
await import(${JSON.stringify(pathToFileURL(join(repo, 'apps/desktop/dist/main.mjs')).href)});
`,
  )
  desktop = spawn(require('electron'), [bootstrap], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      TMPDIR: scratch,
      LITCH_PROFILE: profile,
      LITCH_ENTRY: fixture.socket,
      LITCH_LANG: 'zh-CN',
      LITCH_COMPUTER_USE_APP: process.env.LITCH_COMPUTER_USE_APP,
    },
  })
  desktop.stdout.on('data', (data) => {
    output += data
  })
  desktop.stderr.on('data', (data) => {
    output += data
  })
  desktop.on('error', (error) => {
    output += `\n桌面启动失败：${error.message}\n`
  })
  cleanup.push(async () => {
    if (desktop.exitCode !== null || desktop.signalCode !== null) return
    const ended = new Promise((resolve) => desktop.once('exit', resolve))
    desktop.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (desktop.exitCode === null && desktop.signalCode === null)
        process.kill(-desktop.pid, 'SIGKILL')
    }, 30_000)
    await ended
    clearTimeout(timer)
  })
  const record = (prefix) => {
    if (desktop.exitCode !== null || desktop.signalCode !== null)
      throw new Error(`桌面提前退出：${output.slice(-4000)}`)
    const line = output.split('\n').find((line) => line.startsWith(prefix))
    return line ? JSON.parse(line.slice(prefix.length)) : null
  }
  const identity = await until('自己的隐藏桌面进程', () => record('M16_DESKTOP '), Boolean)
  assert.equal(identity.pid, desktop.pid)
  assert.equal(identity.hidden, true)
  const parent = await until('桌面核心派出父会话', () => record('M16_PARENT '), Boolean)
  const completed = async (threadId) =>
    until(
      '回合完成',
      () => reader.call('thread/read', { threadId, includeTurns: true }),
      ({ thread }) => thread.turns?.some((turn) => turn.status === 'completed'),
      90_000,
    )
  const parentThread = (await completed(parent.parentId)).thread
  const reply = parentThread.turns
    .flatMap((turn) => turn.items)
    .find((item) => item.type === 'agentMessage' && item.text?.startsWith(SESSIONS_HEARD))
  assert.ok(reply, JSON.stringify(parentThread))
  const childId = JSON.parse(reply.text.slice(SESSIONS_HEARD.length).trim()).thread_id
  assert.ok(childId)
  const child = (await completed(childId)).thread
  const items = child.turns.flatMap((turn) => turn.items)
  const result =
    items.find((item) => item.type === 'agentMessage' && item.text?.startsWith(SESSIONS_HEARD))
      ?.text ?? ''
  evidence = {
    identity,
    parent,
    childId,
    items,
    browser: result.includes('M16 后台浏览器真实页面'),
    computer: result.includes('Running apps:'),
  }
  // 核心日志验证没有为子会话发 thread/resume；读取完整历史由旁路只读客户端完成。
  const coreLog = readFileSync(join(profile, 'logs/core.jsonl'), 'utf8')
  writeFileSync(join(directory, 'core.jsonl'), coreLog)
  evidence.childResumed = coreLog
    .split('\n')
    .some((line) => line.includes(childId) && line.includes('thread/resume'))
  assert.equal(evidence.childResumed, false)
  assert.equal(evidence.browser, true, result)
  assert.equal(evidence.computer, true, result)
  const calls = items.filter((item) => item.type === 'dynamicToolCall')
  assert.deepEqual(
    calls.map((item) => [item.namespace, item.tool, item.success]),
    [
      ['litch_browser', 'navigate', true],
      ['litch_browser', 'snapshot', true],
      ['litch_computer', 'list_apps', true],
    ],
  )
  console.log(JSON.stringify({ ...evidence, items: undefined }))
} finally {
  writeFileSync(join(directory, 'desktop.log'), output)
  const errors = []
  for (const close of cleanup.reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  const helperPid = Number(output.match(/助手已就绪：进程 (\d+)/)?.[1])
  const live = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code !== 'ESRCH'
    }
  }
  if (evidence) {
    evidence.cleanup = { desktopPid: desktop.pid, helperPid, exited: false }
    try {
      await until(
        '桌面与助手退出',
        () => [desktop.pid, helperPid].filter(Boolean).every((pid) => !live(pid)),
        Boolean,
        10_000,
      )
      evidence.cleanup.exited = true
    } catch (error) {
      errors.push(error)
    }
    writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
  }
  console.log(`证据：${directory}`)
  if (errors.length) {
    console.error(new AggregateError(errors, '验收进程未完整清理'))
    process.exitCode = 1
  }
}
