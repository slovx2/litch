import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

// 全部系统命令使用隔离替身，不在开发机操作 PF 或请求 sudo。
function fixture(t, result) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-pf-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'calls.jsonl')
  for (const command of ['uname', 'sudo', 'xcrun']) {
    writeFileSync(
      join(dir, command),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({command: '${command}', args}) + '\\n');
if ('${command}' === 'uname') console.log(args[0] === '-s' ? 'Darwin' : 'arm64');
if ('${command}' === 'sudo') {
  if (args.includes('-sr') && !args.includes('-a')) console.log('anchor "com.apple/*" all');
  if (args.includes('-E')) console.log('Token : 12345');
  if (args.includes('-f')) process.stdin.resume();
  if (args.includes('-X') && process.env.MOCK_RESULT === 'cleanup-failure') process.exitCode = 1;
}
if ('${command}' === 'xcrun') {
  if (process.env.MOCK_RESULT === 'signal') { console.log('mock-ready'); setTimeout(() => {}, 20000); }
  else if (process.env.MOCK_RESULT === 'network') { console.error('Error 68.'); process.exitCode = 68; }
}
`,
      { mode: 0o755 },
    )
  }
  return {
    env: {
      HOME: dir,
      PATH: `${dir}:/usr/bin:/bin`,
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      GITHUB_RUN_ID: '42',
      MOCK_LOG: log,
      MOCK_RESULT: result,
    },
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  }
}

function checkCleanup(calls) {
  const sudo = calls.filter((call) => call.command === 'sudo').map((call) => call.args)
  const loaded = sudo.find((args) => args.includes('-f'))
  assert.ok(loaded.includes('-a'), '禁止覆盖全局 PF 规则')
  const anchor = loaded[loaded.indexOf('-a') + 1]
  assert.match(anchor, /^com\.apple\/litch-stapler-42-\d+$/)
  assert.ok(
    sudo.some((args) => args.includes(anchor) && args.includes('-F') && args.includes('rules')),
  )
  assert.deepEqual(sudo.at(-1), ['pfctl', '-X', '12345'])
  assert.equal(sudo.filter((args) => args.includes('-E')).length, 1)
}

test('TCP 包装器只改临时 anchor，成功/票据失败/清理失败都释放 PF 引用', (t) => {
  for (const [result, exit] of [
    ['success', 0],
    ['network', 68],
    ['cleanup-failure', 1],
  ]) {
    const f = fixture(t, result)
    const child = spawnSync(
      'bash',
      ['scripts/ci/stapler-tcp.sh', 'validate', '/fixture/Litch.app'],
      { env: f.env, encoding: 'utf8' },
    )
    assert.equal(child.status, exit, child.stderr)
    checkCleanup(f.calls())
    assert.equal(f.calls().filter((call) => call.command === 'xcrun').length, 1)
  }
})

test('TCP 包装器收到 TERM 时终止票据子进程并撤销规则', async (t) => {
  const f = fixture(t, 'signal')
  const child = spawn(
    'bash',
    [resolve('scripts/ci/stapler-tcp.sh'), 'staple', '/fixture/Litch.app'],
    { env: f.env },
  )
  let stopped = false
  let output = ''
  child.stdout.on('data', (data) => {
    output += data.toString()
    if (!stopped && output.includes('mock-ready')) {
      stopped = true
      child.kill('SIGTERM')
    }
  })
  child.stderr.resume()
  const exit = await new Promise((resolveExit, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolveExit(code))
  })
  assert.equal(stopped, true)
  assert.equal(exit, 143)
  checkCleanup(f.calls())
})
