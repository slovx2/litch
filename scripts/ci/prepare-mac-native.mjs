// 托管Mac和本地兜底共用准备步骤，测试集合只由mac-native-plan定义。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

assert.equal(process.platform, 'darwin')
assert.equal(process.arch, 'arm64')
assert.equal(process.version, 'v24.21.0')
assert.match(
  execFileSync('go', ['version'], { encoding: 'utf8' }).trim(),
  /^go version go1\.26\.10 darwin\/arm64$/,
)
const selected = JSON.parse(process.env.NATIVE_DOMAINS)
const needsAdapter = selected.some((name) => !['browser', 'ios'].includes(name))
const env = { ...process.env }
const run = (command, args) => execFileSync(command, args, { env, stdio: 'inherit' })
run('npm', ['ci', '--no-audit', '--no-fund'])
if (needsAdapter)
  for (const name of ['claude', 'pi', 'dsh', 'opencode', 'acp', 'antigravity'])
    run('npm', ['ci', '--prefix', `packages/${name}`, '--no-audit', '--no-fund'])
run('npm', ['run', 'client:setup'])
run(process.execPath, ['apps/desktop/node_modules/electron/install.js'])
if (selected.includes('client-engines') || selected.includes('adapters')) {
  const file = resolve('.artifacts/local-cli-env')
  mkdirSync(resolve('.artifacts'), { recursive: true })
  writeFileSync(file, '')
  env.GITHUB_ENV = file
  run(process.execPath, ['scripts/ci/install-test-clis.mjs', 'client-engines'])
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
  }
}
if (needsAdapter) run('npm', ['run', 'build'])
if (selected.includes('client')) {
  const dir = resolve('.artifacts/chrome-for-testing')
  mkdirSync(dir, { recursive: true })
  run(process.execPath, [
    'scripts/ci/download.mjs',
    'chrome',
    'https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/mac-arm64/chrome-mac-arm64.zip',
    join(dir, 'chrome.zip'),
  ])
  run('ditto', ['-xk', join(dir, 'chrome.zip'), dir])
  env.LITCH_CHROME_BINARY = join(
    dir,
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  )
  assert.ok(
    execFileSync(env.LITCH_CHROME_BINARY, ['--version'], { encoding: 'utf8' }).includes(
      '151.0.7922.34',
    ),
  )
}
if (selected.some((name) => ['client', 'client-engines'].includes(name)))
  run('npm', ['run', 'client:build'])
run(process.execPath, ['scripts/ci/run-mac-native.mjs'])
