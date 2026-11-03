// 与 Full 的 client job 窗口集合相同；只构建一次，不重试、不隐藏首败。
// 在仓库根目录执行。先准备根/UI/桌面/Pi 依赖、Pi/device/Go 产物与隔离 Chrome。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nightlyChecks } from './nightly-checks.mjs'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const checks = nightlyChecks
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
