// 经理授权的隐藏 Electron：仅本脚本启动的进程，禁可见窗口、抢焦点和系统输入。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as bundle } from '../apps/desktop/node_modules/esbuild/lib/main.js'
import { build } from '../packages/ui/node_modules/vite/dist/node/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, '.local/pdf-electron-check', `${Date.now()}-${process.pid}`)
mkdirSync(out, { recursive: true })
await build({
  configFile: join(root, 'packages/ui/vite.config.ts'),
  root: join(root, 'packages/ui'),
  logLevel: 'warn',
  build: {
    outDir: join(out, 'assets'),
    rollupOptions: {
      input: ['test/pdf/index.html', 'test/pdf/csp.html', 'test/preview/index.html'].map((path) =>
        join(root, 'packages/ui', path),
      ),
    },
  },
})
await bundle({
  entryPoints: [join(root, 'scripts/pdf-electron-probe.mjs')],
  outfile: join(out, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['electron'],
  target: 'node24',
})
const stateTool = join(out, 'window-state')
execFileSync('/usr/bin/swiftc', [join(root, 'scripts/pdf-window-state.swift'), '-o', stateTool])
const windowState = () => JSON.parse(execFileSync(stateTool, { encoding: 'utf8' }))
const processes = () =>
  execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      return m ? [{ pid: +m[1], parent: +m[2], group: +m[3], state: m[4], command: m[5] }] : []
    })
const electron = join(
  root,
  'apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
)
const before = windowState()
assert(
  !processes().some(
    (p) =>
      p.command.startsWith(electron) && (before.visible.includes(p.pid) || before.front === p.pid),
  ),
)
const profile = mkdtempSync(join(tmpdir(), 'litch-pdf-electron-'))
const home = join(profile, 'home')
mkdirSync(home)
const log = openSync(join(out, 'electron.log'), 'w')
const child = spawn(electron, [join(out, 'main.mjs')], {
  detached: true,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmpdir(),
    LITCH_PDF_CHECK_PROFILE: profile,
    LITCH_PDF_CHECK_OUT: out,
  },
  stdio: ['ignore', log, log],
})
const owned = new Set([child.pid])
const monitor = { before: '未发现本工作树可见窗口', samples: 0, violation: null }
const check = () => {
  const rows = processes(),
    state = windowState()
  for (let i = 0; i < 4; i++)
    for (const p of rows) if (p.group === child.pid || owned.has(p.parent)) owned.add(p.pid)
  monitor.samples++
  if (
    rows.some((p) => owned.has(p.pid) && (state.visible.includes(p.pid) || state.front === p.pid))
  ) {
    monitor.violation = '检测到可见窗口或抢焦点，停止进程树'
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
    for (const p of owned)
      try {
        process.kill(p, 'SIGKILL')
      } catch {}
  }
}
check()
const timer = setInterval(check, 250)
const code = await new Promise((resolve) => child.once('exit', resolve))
clearInterval(timer)
await new Promise((resolve) => setTimeout(resolve, 500))
monitor.remaining = processes()
  .filter((p) => owned.has(p.pid) && !p.state.startsWith('Z'))
  .map((p) => p.pid)
writeFileSync(join(out, 'window-monitor.json'), JSON.stringify(monitor, null, 2))
console.log(JSON.stringify({ out, code, monitor }))
console.log(readFileSync(join(out, 'electron.log'), 'utf8').slice(-4000))
assert(code === 0 && !monitor.violation && !monitor.remaining.length)
