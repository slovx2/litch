// 仅用于本机隔离 UI 验收；CDP 只连本脚本启动、核对监听 PID 后的测试 Electron。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const directory = process.env.LITCH_CU_UI_PROFILE
if (!directory?.startsWith('/tmp/litch-cu-ui-')) throw new Error('需要隔离的 LITCH_CU_UI_PROFILE')
const statePath = join(directory, 'probe-state.json')
if (process.argv[2] === 'launch') {
  if (!process.env.LITCH_ENTRY?.startsWith('unix:///')) throw new Error('需要隔离夹具入口')
  mkdirSync(join(directory, 'home'), { recursive: true })
  mkdirSync(join(directory, 'codex'), { recursive: true })
  writeFileSync(
    join(directory, 'devices.json'),
    JSON.stringify({
      version: 1,
      localWire: null,
      remotes: [],
      tools: { local: { computer: true, browser: false } },
    }),
  )
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  if (port === 9333) throw new Error('禁止端口')
  const log = openSync(join(directory, 'electron.log'), 'a')
  const app = spawn(
    join(root, 'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    [join(root, 'apps/desktop'), `--remote-debugging-port=${port}`],
    {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        HOME: join(directory, 'home'),
        CODEX_HOME: join(directory, 'codex'),
        LITCH_PROFILE: directory,
        LITCH_LANG: 'zh-CN',
        LITCH_COMPUTER_USE_APP: join(
          root,
          'apps/computer-use/.artifacts/integration/Litch Background Input Probe.app',
        ),
      },
    },
  )
  app.unref()
  const awake = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(app.pid)], {
    detached: true,
    stdio: 'ignore',
  })
  awake.unref()
  writeFileSync(statePath, JSON.stringify({ port, pid: app.pid, caffeinate: awake.pid }))
  for (let i = 0; i < 100; i++) {
    try {
      const ids = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')
      if (!ids.includes(String(app.pid))) throw new Error('CDP PID不匹配')
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (pages.some((page) => page.type === 'page')) {
        console.log(JSON.stringify({ port, pid: app.pid }))
        process.exit(0)
      }
    } catch {}
    await delay(100)
  }
  throw new Error('测试窗口未就绪')
}
const { port, pid, caffeinate } = JSON.parse(readFileSync(statePath, 'utf8'))
if (process.argv[2] === 'stop') {
  process.kill(pid, 'SIGTERM')
  try {
    process.kill(caffeinate, 'SIGTERM')
  } catch {}
  process.exit(0)
}
const listeners = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
if (!listeners.includes(String(pid))) throw new Error('CDP监听进程已改变')
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = pages.find((page) => page.type === 'page' && page.url.startsWith('app://ui/'))
if (!page) throw new Error('没有测试UI')
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
let next = 0
const waiting = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const pending = waiting.get(message.id)
  if (pending) {
    waiting.delete(message.id)
    message.error
      ? pending.reject(new Error(JSON.stringify(message.error)))
      : pending.resolve(message.result)
  }
}
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++next
    waiting.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const timer = setTimeout(() => {
  socket.close()
  process.exitCode = 1
}, 15000)
try {
  if (process.argv[2] === 'shot') {
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(process.argv[3], Buffer.from(shot.data, 'base64'))
    console.log(process.argv[3])
  } else {
    const result = await call('Runtime.evaluate', {
      expression: process.argv[3],
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    console.log(JSON.stringify(result.result.value))
  }
} finally {
  clearTimeout(timer)
  socket.close()
}
