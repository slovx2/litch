// 隐藏 Electron 跨进程验收：只使用临时 HOME、本地假站点和模拟钥匙串。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const electron = process.env.LITCH_ELECTRON_BINARY ?? require('electron')
const appDir = fileURLToPath(new URL('..', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'litch-cookie-restart-'))
const profile = join(root, 'profile')
mkdirSync(profile)
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
}
try {
  await build({
    ...common,
    entryPoints: [join(appDir, 'src/probe-browser-persistence.mts')],
    outfile: join(root, 'probe.mjs'),
    format: 'esm',
  })
  await build({
    ...common,
    entryPoints: [join(appDir, 'src/browser/passwords/preload.mts')],
    outfile: join(root, 'autofill-preload.cjs'),
    format: 'cjs',
  })
  for (const stage of [
    'seed',
    'read',
    'logout',
    'read-logout',
    'seed',
    'clear',
    'read-clear',
    'crash',
    'read',
  ]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [join(root, 'probe.mjs'), stage], {
        env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, LITCH_PROFILE: profile },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', () => {})
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
      child.on('error', reject)
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, output })
      })
    })
    assert.ok(
      result.output.includes(`"stage":"${stage}","ok":true`),
      `${stage} 未通过：${result.output}`,
    )
    assert.equal(stage === 'crash' ? result.signal : result.code, stage === 'crash' ? 'SIGKILL' : 0)
    console.log(`会话持久化：${stage} 通过`)
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
