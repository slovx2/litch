// 在 Windows 上跑 litch_machine 的原生脚本和正式 process/*、fs/* 冒烟。
// 用法：npm ci 后 node scripts/check-machine-windows.mjs。无需 harness、模型或 GUI；不改用户配置。
// 这不代替跨 SSH 的真实窗口验收（审批卡、标题栏、远端 CLI）。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error(
    '此验收必须在 Windows 上运行；macOS 的路径与命令拼装单测见 packages/core/test/machine-windows.test.mts。',
  )
  process.exit(1)
}
const repo = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'litch-machine-check-'))
const env = {}
for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) {
  const entry = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )
  if (entry) env[name] = entry[1]
}
const system = env.SystemRoot ?? 'C:\\Windows'
Object.assign(env, {
  PATH: [
    dirname(process.execPath),
    join(system, 'System32'),
    join(system, 'System32/WindowsPowerShell/v1.0'),
  ].join(';'),
  HOME: root,
  USERPROFILE: root,
  CODEX_HOME: join(root, '.codex'),
  CLAUDE_CONFIG_DIR: join(root, '.claude'),
  APPDATA: join(root, 'AppData/Roaming'),
  LOCALAPPDATA: join(root, 'AppData/Local'),
})
for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA'])
  mkdirSync(env[name], { recursive: true })
const run = (args, timeout) => {
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`检查失败：退出码 ${result.status}`)
}
try {
  run(['node_modules/typescript/bin/tsc', '-p', 'packages/core/test/tsconfig.json'], 120_000)
  run(
    [
      '--test',
      'packages/core/dist/packages/core/test/machine-windows.test.mjs',
      'packages/core/dist/packages/core/test/machine-windows-rpc.test.mjs',
    ],
    240_000,
  )
  console.log('Windows 本机执行链检查通过；跨 SSH、GUI 审批和系统通知仍需真实窗口验收。')
} finally {
  rmSync(root, { recursive: true, force: true })
}
