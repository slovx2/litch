// 生命周期单测的假 Expo/验收进程，不连接真实设备或浏览器。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { setTimeout as pause } from 'node:timers/promises'

const report = process.env.LITCH_FIXTURE_REPORT
const mode = process.env.LITCH_FIXTURE_MODE
const record = (phase, extra = {}) =>
  appendFileSync(
    report,
    `${JSON.stringify({ phase, pid: process.pid, home: process.env.HOME, ...extra })}\n`,
  )
const records = () =>
  readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const isExpo = process.argv.includes('--web')

if (process.argv[2] === 'worker') {
  // 模拟父进程已结束、仍持有端口且忽略 TERM 的孙进程。
  process.on('SIGTERM', () => {})
  const server = createServer((_, response) => response.end('worker'))
  server.listen(0, '127.0.0.1', () => record('worker', { port: server.address().port }))
} else if (isExpo) {
  const port = Number(process.argv[process.argv.indexOf('--port') + 1])
  assert.equal(process.env.CI, undefined)
  assert.equal(process.env.OPENAI_API_KEY, undefined)
  assert.equal(process.env.LITCH_DEVICE_SOCKET, undefined)
  assert.equal(process.env.EXPO_PUBLIC_LITCH_E2E, '1')
  assert.equal(process.env.EXPO_NO_TYPESCRIPT_SETUP, '1')
  assert.equal(process.env.EXPO_NO_DOTENV, '1')
  record('expo', { port, cwd: process.cwd() })
  if (mode === 'start-fail') {
    console.error('虚构 Expo 启动失败')
    process.exit(12)
  }
  const server = createServer((_, response) => response.end('preview'))
  server.listen(port, '127.0.0.1', () => {
    if (mode !== 'timeout') console.log(`Waiting on http://localhost:${port}`)
    if (mode === 'server-exit') setTimeout(() => process.exit(13), 1000)
  })
} else {
  const url = new URL(process.argv[2])
  assert.equal(url.searchParams.get('app'), '1')
  assert.equal(url.searchParams.get('scene'), 'manager-console')
  assert.equal((await fetch(url)).ok, true)
  record('probe', { url: String(url) })
  if (mode === 'probe-fail') process.exit(7)
  if (mode === 'orphan') {
    const worker = spawn(process.execPath, [import.meta.filename, 'worker'], {
      env: process.env,
      stdio: 'ignore',
    })
    worker.unref()
    while (!records().some((row) => row.phase === 'worker')) await pause(20)
  }
  if (mode === 'server-exit' || mode === 'interrupt') setInterval(() => {}, 1000)
}
