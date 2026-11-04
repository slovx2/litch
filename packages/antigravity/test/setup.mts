import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'litch-agy-test-home-'))
for (const key of Object.keys(process.env))
  if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|GOOGLE_APPLICATION_CREDENTIALS/.test(key))
    delete process.env[key]
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CODEX_HOME = join(home, 'codex')
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.on('exit', () => rmSync(home, { recursive: true, force: true }))
