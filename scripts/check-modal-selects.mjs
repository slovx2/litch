// 用隔离的 Electron 和真正的 CDP 输入测试桌面下拉框。--diagnose 输出未修复基线。
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../packages/ui/node_modules/vite/dist/node/index.js'
import { withChromiumTestArgs } from '../third_party/litch-automation/scripts/chromium-test-args.mjs'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const electron = require('electron')
const profile = await mkdtemp(join(tmpdir(), 'litch-modal-select-'))
const evidence = process.env.LITCH_MODAL_SELECT_EVIDENCE
const evidenceDir = evidence ? resolve(evidence) : null
const vite = await createServer({
  root: fileURLToPath(new URL('../packages/ui', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false },
  logLevel: 'error',
})
try {
  if (evidenceDir) await mkdir(evidenceDir, { recursive: true })
  await vite.listen()
  const child = spawn(
    electron,
    withChromiumTestArgs([
      fileURLToPath(new URL('../apps/desktop/scripts/modal-select-window.mjs', import.meta.url)),
    ]),
    {
      env: {
        PATH: process.env.PATH,
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: profile,
        USERPROFILE: profile,
        CODEX_HOME: join(profile, 'codex'),
        LITCH_SELECT_PROFILE: profile,
        LITCH_SELECT_URL: `${vite.resolvedUrls.local[0]}test/modal-select-fixture.html`,
        LITCH_SELECT_DIAGNOSE: process.argv.includes('--diagnose') ? '1' : '0',
        ...(evidenceDir ? { LITCH_SELECT_EVIDENCE: evidenceDir } : {}),
      },
      stdio: 'inherit',
    },
  )
  process.exitCode = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => child.kill(), 120_000)
    child.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(deadline)
      resolve(code ?? 1)
    })
  })
} finally {
  await vite.close()
  await rm(profile, { recursive: true, force: true })
}
