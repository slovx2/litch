import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'litch-remote-upload-e2e-'))
const home = join(temp, 'home')
const profile = join(temp, 'profile')
mkdirSync(home)
mkdirSync(profile)
writeFileSync(join(profile, 'empty.cjs'), '// 隔离预载\n')
try {
  const output = join(temp, 'probe.mjs')
  await build({
    entryPoints: [join(root, 'src/probe-remote-upload.mts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['electron'],
  })
  const result = execFileSync(electron, [output], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
      LITCH_REMOTE_UPLOAD_PROFILE: profile,
      ELECTRON_RUN_AS_NODE: '',
    },
  })
  console.log(result.trim())
} finally {
  rmSync(temp, { recursive: true, force: true })
}
