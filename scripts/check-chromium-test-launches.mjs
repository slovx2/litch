// 产品验收与独立自动化包共用启动规范；不扫描或改变产品浏览器的启动行为。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const shared = new URL('../third_party/litch-automation/scripts/', import.meta.url)
for (const args of [
  ['--test', fileURLToPath(new URL('chromium-test-launches.test.mjs', shared))],
  [fileURLToPath(new URL('check-chromium-test-launches.mjs', shared)), root],
  [fileURLToPath(new URL('check-chromium-test-launches.mjs', shared))],
])
  execFileSync(process.execPath, args, { stdio: 'inherit' })
