// 先 client:build；隐藏 Electron 加载正式组件和模拟核心，不接触用户会话。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'
import { assertUiBuildFresh } from './ui-build-state.mjs'

assertUiBuildFresh()
const profile = mkdtempSync(join(tmpdir(), 'litch-media-window-'))
const output = resolve('.artifacts/media-p1/desktop')
mkdirSync(output, { recursive: true })
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
  withChromiumTestArgs([resolve('apps/desktop/scripts/media-window.mjs')]),
  {
    env: {
      PATH: process.env.PATH,
      HOME: profile,
      CODEX_HOME: join(profile, '.codex'),
      CLAUDE_CONFIG_DIR: join(profile, '.claude'),
      LITCH_MEDIA_PROFILE: profile,
      LITCH_MEDIA_OUTPUT: output,
      LITCH_MEDIA_URL: `${vite.resolvedUrls.local[0]}test/media-fixture.html?lang=zh-CN`,
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
