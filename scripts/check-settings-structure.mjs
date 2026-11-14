// 设置结构验收：只用模拟核心、隔离 HOME 和隐藏 Electron，不连接真实设备。
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(join(root, 'apps/desktop/package.json'))
const home = await mkdtemp(join(tmpdir(), 'litch-settings-structure-'))
const output = resolve(
  process.env.LITCH_SETTINGS_OUTPUT ?? join(root, '.artifacts/settings-structure'),
)
await mkdir(output, { recursive: true })
const server = await createServer({
  root: join(root, 'packages/ui'),
  configFile: join(root, 'packages/ui/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})
await server.listen()
try {
  const child = spawn(
    require('electron'),
    withChromiumTestArgs([join(root, 'scripts/settings-structure-electron.mjs')]),
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        LITCH_LOG_DIR: join(home, 'logs'),
        LITCH_SETTINGS_URL: `http://127.0.0.1:${server.httpServer.address().port}`,
        LITCH_SETTINGS_OUTPUT: output,
        LITCH_SETTINGS_BEFORE: process.argv.includes('--before') ? '1' : '0',
        ...(process.env.LITCH_SETTINGS_MOBILE_URL
          ? { LITCH_SETTINGS_MOBILE_URL: process.env.LITCH_SETTINGS_MOBILE_URL }
          : {}),
      },
      stdio: 'inherit',
    },
  )
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  try {
    const code = await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', done)
    })
    if (code !== 0) throw new Error(`设置结构验收失败：${code}`)
  } finally {
    clearTimeout(timer)
  }
} finally {
  await server.close()
}
