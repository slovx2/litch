// 隐藏 Electron 的 app:// 验证。macOS 用原生窗口采样证明没有可见窗口或抢焦点。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { docx, xlsx } from '../packages/ui/test/office-fixtures.mjs'

const root = resolve(import.meta.dirname, '..')
const assets = process.argv[2]
assert(assets, '传入 check-office-preview 的 assets 目录')
const home = mkdtempSync(join(tmpdir(), 'litch-office-electron-'))
const out = join(root, '.local', `office-electron-${Date.now()}`)
mkdirSync(out)
const payloads = {}
for (const [format, bytes] of [
  ['docx', await docx(true)],
  ['xlsx', await xlsx()],
])
  payloads[format] = {
    kind: 'ready',
    format,
    bytes: bytes.length,
    dataBase64: Buffer.from(bytes).toString('base64'),
  }
const payloadFile = join(home, 'payloads.json')
writeFileSync(payloadFile, JSON.stringify(payloads))
const audit = join(root, '.local/office-window-state')
execFileSync('swiftc', [join(root, 'scripts/office-preview/window-state.swift'), '-o', audit])
const sample = () => JSON.parse(execFileSync(audit, { encoding: 'utf8' }))
const samples = [sample()]
const executable = join(
  root,
  'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
)
let child,
  timer,
  stdout = '',
  stderr = '',
  violation = false
const descendants = (pid) => {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
  const pids = new Set([pid])
  let more = true
  while (more) {
    more = false
    for (const [p, parent] of rows)
      if (pids.has(parent) && !pids.has(p)) {
        pids.add(p)
        more = true
      }
  }
  return pids
}
const tracked = new Set()
try {
  child = spawn(
    executable,
    [
      join(root, 'scripts/office-preview/probe.cjs'),
      '--use-mock-keychain',
      '--password-store=basic',
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: home,
        LITCH_OFFICE_PROFILE: join(home, 'profile'),
        LITCH_OFFICE_ASSETS: resolve(assets),
        LITCH_OFFICE_PAYLOADS: payloadFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.on('data', (data) => {
    stdout += data
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  timer = setInterval(() => {
    const state = sample(),
      pids = descendants(child.pid)
    for (const p of pids) tracked.add(p)
    samples.push({ ...state, pids: [...pids] })
    if (pids.has(state.front) || state.visible.some((p) => pids.has(p))) {
      violation = true
      for (const pid of [...pids].reverse()) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  }, 200)
  const code = await new Promise((resolve) => child.once('exit', resolve))
  clearInterval(timer)
  samples.push(sample())
  assert.equal(violation, false, '不允许可见或激活测试进程')
  assert.equal(code, 0, stderr)
  const result = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(result.ok, true)
  await new Promise((r) => setTimeout(r, 300))
  const living = [...tracked].filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  assert.deepEqual(living, [], '探针进程不能残留')
  writeFileSync(join(out, 'report.json'), JSON.stringify({ result, samples, living }, null, 2))
  console.log(out, result)
} finally {
  clearInterval(timer)
  if (child?.exitCode === null)
    for (const pid of [...descendants(child.pid)].reverse()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  writeFileSync(join(out, 'stdout.log'), stdout)
  writeFileSync(join(out, 'stderr.log'), stderr)
  writeFileSync(join(out, 'windows.json'), JSON.stringify(samples, null, 2))
}
