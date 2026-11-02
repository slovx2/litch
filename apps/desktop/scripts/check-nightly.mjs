// 与 Full 的 client job 窗口集合相同；只构建一次，不重试、不隐藏首败。
// 在仓库根目录执行。先准备根/UI/桌面/Pi 依赖、Pi/device/Go 产物与隔离 Chrome。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const desktop = 'apps/desktop/scripts/'
const checks = [
  ['smoke', `${desktop}smoke.mjs`],
  ['scroll', `${desktop}smoke.mjs`, '--scroll'],
  ['scroll:wheel', `${desktop}check-scroll-wheel.mjs`],
  ['compose', `${desktop}smoke.mjs`, '--compose'],
  ['projections', 'scripts/check-sidebar-projections.mjs'],
  ['smoke:entry', `${desktop}smoke.mjs`, '--entry'],
  ['scroll:entry', `${desktop}smoke.mjs`, '--scroll', '--entry'],
  ['compose:entry', `${desktop}smoke.mjs`, '--compose', '--entry'],
  ['terminal', `${desktop}check-terminal.mjs`],
  ['files', `${desktop}check-files.mjs`],
  ['settings', `${desktop}check-settings.mjs`],
  ['navigation', `${desktop}smoke.mjs`, '--navigation'],
  ['text-scale', `${desktop}check-text-scale.mjs`],
  ['full:mock', `${desktop}smoke.mjs`, '--full', '--mock'],
  ['sidebar', `${desktop}smoke.mjs`, '--sidebar'],
  ['full:entry', `${desktop}smoke.mjs`, '--full'],
  ['manage:mock', `${desktop}smoke.mjs`, '--manage', '--mock'],
  ['manage:entry', `${desktop}smoke.mjs`, '--manage'],
  ['harness-settings', `${desktop}smoke.mjs`, '--harness-settings'],
  ['adapter', `${desktop}check-adapter.mjs`],
  ['diff', `${desktop}check-diff.mjs`],
  ['ssh', `${desktop}check-ssh.mjs`],
  ['remote', `${desktop}smoke.mjs`, '--remote'],
  ['remote:service', `${desktop}smoke.mjs`, '--remote', '--service'],
  ['machine-enable', `${desktop}check-machine-enable.mjs`],
]
const run = (binary, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: repo, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }))
  })
const start = performance.now()
const built = await run('npm', ['run', 'client:build'])
if (built.code !== 0) process.exit(built.code)
const results = []
for (const [name, ...args] of checks) {
  const at = performance.now()
  console.log(`CLIENT_CHECK_START ${name}`)
  const result = {
    name,
    ...(await run(process.execPath, args)),
    seconds: (performance.now() - at) / 1000,
  }
  results.push(result)
  console.log(`CLIENT_CHECK_RESULT ${JSON.stringify(result)}`)
}
console.log(
  `CLIENT_CHECK_TOTAL ${JSON.stringify({ seconds: (performance.now() - start) / 1000, results })}`,
)
if (results.some((result) => result.code !== 0)) process.exitCode = 1
