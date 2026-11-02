import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { infrastructureRetryReason, recoverAdb } from './maestro-infrastructure.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'litch-infra-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}
function executable(path, code) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!${process.execPath}\n${code}`, { mode: 0o755 })
}
const launch = {
  command: { launchAppCommand: { appId: 'dev.litch.app' } },
  metadata: { status: 'FAILED', error: { message: 'Unable to launch app dev.litch.app' } },
}

test('阶段与基础设施特征缺一不可；伴随掉线的产品断言也不重试', (t) => {
  const directory = temporary(t)
  const commandFile = join(directory, 'commands-test.json')
  writeFileSync(commandFile, JSON.stringify([launch]))
  assert.equal(infrastructureRetryReason(directory, 'dev.litch.app', false), null)
  assert.match(infrastructureRetryReason(directory, 'dev.litch.app', true), /reverse 映射丢失/)
  writeFileSync(
    join(directory, 'maestro.log'),
    'Caused by: java.io.IOException: Command failed (host:transport:emulator-5554): device offline',
  )
  assert.match(infrastructureRetryReason(directory, 'dev.litch.app', false), /device offline/)
  writeFileSync(
    commandFile,
    JSON.stringify([launch, { command: { runFlowCommand: {} }, metadata: { status: 'FAILED' } }]),
  )
  assert.match(infrastructureRetryReason(directory, 'dev.litch.app', false), /device offline/)
  const assertion = { command: { assertConditionCommand: {} }, metadata: { status: 'FAILED' } }
  writeFileSync(commandFile, JSON.stringify([assertion]))
  assert.equal(infrastructureRetryReason(directory, 'dev.litch.app', true), null)
  writeFileSync(commandFile, JSON.stringify([launch, assertion]))
  assert.equal(infrastructureRetryReason(directory, 'dev.litch.app', true), null)
  writeFileSync(commandFile, 'broken JSON')
  assert.equal(infrastructureRetryReason(directory, 'dev.litch.app', true), null)
})

test('先等上线，再恢复全部 reverse 并核对；恢复不完整就失败', async () => {
  const commands = []
  const rules = [
    ['tcp:8765', 'tcp:1234'],
    ['tcp:2345', 'tcp:2345'],
  ]
  await recoverAdb(async (...args) => {
    commands.push(args)
    return args[0] === 'get-state'
      ? 'device\n'
      : args[1] === '--list'
        ? 'emulator tcp:8765 tcp:1234\nemulator tcp:2345 tcp:2345'
        : ''
  }, rules)
  assert.deepEqual(commands, [
    ['wait-for-device'],
    ['get-state'],
    ['reverse', ...rules[0]],
    ['reverse', ...rules[1]],
    ['reverse', '--list'],
  ])
  await assert.rejects(
    recoverAdb(async (...args) => (args[0] === 'get-state' ? 'device' : ''), rules),
    /未恢复完整/,
  )
  await assert.rejects(
    recoverAdb(async () => 'offline', rules),
    /仍未上线/,
  )
  await assert.rejects(
    recoverAdb(
      async (...args) => (args[0] === 'get-state' ? 'device' : 'emulator tcp:8765 tcp:12345'),
      [rules[0]],
    ),
    /未恢复完整/,
  )
})

for (const [mode, attempts, exitCode] of [
  ['offline-once', 2, 0],
  ['offline-always', 2, 1],
  ['launch-without-feature', 1, 1],
  ['assert-offline', 1, 1],
  ['recovery-offline', 1, 1],
]) {
  test(`执行器基础设施恢复：${mode}`, (t) => {
    const directory = temporary(t)
    const android = join(directory, 'android')
    const maestro = join(directory, 'maestro')
    const events = join(directory, 'events.jsonl')
    const summary = join(directory, 'summary.md')
    const artifacts = join(directory, 'artifacts')
    const apk = join(directory, 'input.apk')
    writeFileSync(apk, 'fake')
    executable(
      join(android, 'platform-tools/adb'),
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.EVENTS, JSON.stringify({kind:'adb',args}) + '\\n');
      if (args[0] === 'devices') console.log('List of devices attached\\nemulator-5554\\tdevice\\n');
      else if (args.includes('get-state')) console.log(process.env.MODE === 'recovery-offline' ? 'offline' : 'device');
      else if (!args.includes('--list')) console.log('diagnostic');`,
    )
    executable(
      maestro,
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const args = process.argv.slice(2);
      const debug = args[args.indexOf('--debug-output') + 1];
      const attempt = debug.endsWith('attempt-1') ? 1 : 2;
      const mode = process.env.MODE;
      const failed = !(mode === 'offline-once' && attempt === 2);
      fs.appendFileSync(process.env.EVENTS, JSON.stringify({kind:'maestro',attempt}) + '\\n');
      const command = mode === 'assert-offline' ? {assertConditionCommand:{}} : {launchAppCommand:{appId:'dev.litch.app'}};
      fs.writeFileSync(path.join(debug,'commands-test.json'),JSON.stringify([{command,metadata:{status:failed?'FAILED':'COMPLETED',error:{message:'test'}}}]));
      fs.writeFileSync(path.join(debug,'maestro.log'),mode === 'launch-without-feature' ? 'other failure' : 'java.io.IOException: device offline');
      fs.writeFileSync(args[args.indexOf('--output') + 1], failed ? '<testsuite><testcase><failure>first failure</failure></testcase></testsuite>' : '<testsuite/>');
      process.exit(failed ? 1 : 0);`,
    )
    const result = spawnSync(
      process.execPath,
      [
        join(repo, 'apps/mobile/scripts/e2e.mjs'),
        '--serial',
        'emulator-5554',
        '--apk',
        apk,
        '--only',
        join(repo, 'apps/mobile/e2e/flows/mock/01-home.yaml'),
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          HOME: directory,
          ANDROID_HOME: android,
          MAESTRO: maestro,
          MODE: mode,
          EVENTS: events,
          LITCH_E2E_ARTIFACTS: artifacts,
          GITHUB_STEP_SUMMARY: summary,
        },
        encoding: 'utf8',
        timeout: 20000,
      },
    )
    assert.equal(result.status, exitCode, result.stderr)
    const rows = readFileSync(join(artifacts, 'flows.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(rows.length, attempts)
    assert.equal(rows[0].status, 1)
    assert.match(
      readFileSync(join(artifacts, 'mock/01-home/attempt-1/junit.xml'), 'utf8'),
      /first failure/,
    )
    assert.ok(existsSync(join(artifacts, 'mock/01-home/attempt-1/screen.png')))
    if (attempts === 2) {
      assert.equal(rows[1].attempt, 2)
      assert.match(rows[1].retryReason, /device offline/)
      assert.match(readFileSync(summary, 'utf8'), /基础设施重试：1 次/)
      const observed = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse)
      const wait = observed.findIndex((event) => event.args?.includes('wait-for-device'))
      const verify = observed.findIndex((event) => event.args?.includes('--list'))
      const rerun = observed.findIndex((event) => event.kind === 'maestro' && event.attempt === 2)
      assert.ok(wait >= 0 && verify > wait && rerun > verify)
    }
  })
}
