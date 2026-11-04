// 原Full/adapters-macos的完整集合，纳入共用Mac证明后本地和托管执行相同命令。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const run = (command, args, env = process.env) =>
  execFileSync(command, args, { env, stdio: 'inherit' })
for (const script of ['check', 'typecheck']) run('npm', ['run', script])
for (const suite of ['claude', 'pi', 'device'])
  run(process.execPath, ['scripts/ci/test-shard.mjs', suite])
run('npm', ['run', 'test:antigravity'])
run('go', ['test', './...'])
const version = JSON.parse(readFileSync('protocol/versions.json')).claudeContextCli
run('npm', [
  'install',
  '--prefix',
  '.artifacts/context-cli',
  '--save-exact',
  `@anthropic-ai/claude-code@${version}`,
  '--no-audit',
  '--no-fund',
])
const tests = readdirSync('packages/claude/dist/claude/test/context-window-cli')
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => `packages/claude/dist/claude/test/context-window-cli/${name}`)
run(
  process.execPath,
  [
    '--import',
    './packages/claude/dist/claude/test/fixtures/isolate-process.mjs',
    '--test',
    '--test-force-exit',
    ...tests,
  ],
  { ...process.env, CHA_CLAUDE_CLI: resolve('.artifacts/context-cli/node_modules/.bin/claude') },
)
for (const script of ['mobile:test', 'test:local-ssh', 'docs:build']) run('npm', ['run', script])
for (const script of ['scripts/install.sh', 'scripts/adapter-launcher.sh'])
  run('sh', ['-n', script])
run(process.execPath, [
  '--test',
  'scripts/install-disk-space.test.mjs',
  'scripts/remote-upgrade-disk.test.mjs',
])
const out = resolve('.artifacts/mac-adapter-release')
run(process.execPath, ['scripts/package-adapter.mjs', '--target', 'host', '--out', out])
const home = resolve('.artifacts/mac-adapter-install-home')
mkdirSync(home, { recursive: true })
const tar = readdirSync(out).find((name) => /^codex-harness-adapter-.*\.tar\.gz$/.test(name))
run('sh', [`${out}/install.sh`, '--from', `${out}/${tar}`], { ...process.env, HOME: home })
run(`${home}/.local/bin/codex-harness-adapter`, ['version'])
