// 隐藏 Electron 运行真实 Chrome 设置组件；通道夹具不接个人浏览器，不留截图或报告。
// node scripts/chrome-e2e/settings.mjs
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../../third_party/litch-automation/scripts/chromium-test-args.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(root, 'apps/desktop/package.json'))
const home = await mkdtemp(join(tmpdir(), 'litch-chrome-settings-'))
let server
let child
try {
  server = await createServer({
    root: join(root, 'packages/ui'),
    configFile: join(root, 'packages/ui/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const address = server.httpServer.address()
  child = spawn(
    require('electron'),
    withChromiumTestArgs([join(root, 'scripts/chrome-e2e/settings-electron.mjs')]),
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        TMPDIR: home,
        LITCH_LOG_DIR: join(home, 'logs'),
        LITCH_SETTINGS_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: 'inherit',
    },
  )
  const stop = () => child.kill('SIGKILL')
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const timer = setTimeout(stop, 120_000)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    if (code !== 0) throw new Error(`Chrome settings failed: ${code}`)
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
} finally {
  child?.kill('SIGKILL')
  await server?.close()
  await rm(home, { recursive: true, force: true })
}
