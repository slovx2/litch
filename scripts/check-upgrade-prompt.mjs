// 隔离 HOME 与用户数据，启动隐藏 Electron，不安装或升级任何真实设备。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'

const profile = mkdtempSync(join(tmpdir(), 'litch-upgrade-window-'))
const vite = await createServer({
  root: resolve('packages/ui'),
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
await vite.listen()
const electron =
  process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
const child = spawn(
  resolve('apps/desktop/node_modules/electron/dist', electron),
  [resolve('apps/desktop/scripts/upgrade-prompt-window.mjs')],
  {
    env: {
      PATH: process.env.PATH,
      HOME: profile,
      CODEX_HOME: join(profile, '.codex'),
      CLAUDE_CONFIG_DIR: join(profile, '.claude'),
      LITCH_UPGRADE_PROFILE: profile,
      LITCH_UPGRADE_URL: `${vite.resolvedUrls.local[0]}test/upgrade-prompt-fixture.html?lang=zh-CN`,
    },
    stdio: 'inherit',
  },
)
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('exit', (code) => resolve(code ?? 1))
    child.once('error', reject)
  })
} finally {
  await vite.close()
}
console.log(`验收截图：${profile}`)
