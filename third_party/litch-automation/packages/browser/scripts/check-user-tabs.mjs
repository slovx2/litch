// node scripts/check-user-tabs.mjs；自有隐藏 Electron 窗口及隔离 HOME，无真实账号。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { withChromiumTestArgs } from '../../../scripts/chromium-test-args.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const electron = createRequire(join(root, 'package.json'))('electron')
const temp = mkdtempSync(join(tmpdir(), 'browser-user-tabs-'))
try {
  const home = join(temp, 'home'),
    profile = join(temp, 'profile')
  mkdirSync(home)
  mkdirSync(profile)
  writeFileSync(join(profile, 'empty-preload.cjs'), '// 隔离夹具\n')
  const outfile = join(temp, 'fixture.mjs')
  await build({
    entryPoints: [join(root, 'test/user-tabs-electron.fixture.mts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron'],
  })
  const result = spawnSync(electron, withChromiumTestArgs([outfile]), {
    timeout: 60_000,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: temp,
      BROWSER_FIXTURE_PROFILE: profile,
      ...(process.env.BROWSER_USER_TAB_SHOTS
        ? { BROWSER_USER_TAB_SHOTS: process.env.BROWSER_USER_TAB_SHOTS }
        : {}),
      ELECTRON_RUN_AS_NODE: '',
    },
  })
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`)
  assert.match(result.stdout, /BROWSER_USER_TABS_ELECTRON_OK/)
  console.log(result.stdout.trim())
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
