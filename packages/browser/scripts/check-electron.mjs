import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const require = createRequire(join(root, 'apps/desktop/package.json'))
const electron = require('electron')
const temp = mkdtempSync(join(tmpdir(), 'browser-host-fixture-'))
const home = join(temp, 'home'),
  profile = join(temp, 'profile'),
  outfile = join(temp, 'fixture.mjs')
mkdirSync(home)
mkdirSync(profile)
writeFileSync(join(profile, 'empty-preload.cjs'), '// 隔离宿主夹具没有密码输入。\n')
await build({
  entryPoints: [join(root, 'packages/browser/test/electron-host.fixture.mts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
})
const output = execFileSync(electron, [outfile], {
  timeout: 90000,
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CHA_STATE_DIR: join(home, 'adapter'),
    BROWSER_FIXTURE_PROFILE: profile,
    ELECTRON_RUN_AS_NODE: '',
  },
})
assert.match(output, /BROWSER_PACKAGE_ELECTRON_OK/)
console.log(output.trim())
