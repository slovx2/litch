import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fakeHealthAdb } from './android-health-fake.mjs'
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

for (const [mode, attempts, exitCode, clipboard = false, restoreReverse = true] of [
  ['offline-once', 2, 0],
  ['offline-always', 2, 1],
  ['offline-then-driver-timeout', 2, 1],
  ['launch-without-feature', 1, 1],
  ['assert-offline', 1, 1],
  ['recovery-offline', 1, 1],
  ['offline-once', 2, 0, true],
  ['offline-always', 2, 1, true],
  ['offline-once', 1, 1, true, false],
]) {
  const scope = clipboard ? `，剪贴板${restoreReverse ? '' : '映射恢复不完整'}` : ''
  test(`执行器基础设施恢复：${mode}${scope}`, (t) => {
    const directory = temporary(t)
    const android = join(directory, 'android')
    const maestro = join(directory, 'maestro')
    const events = join(directory, 'events.jsonl')
    const summary = join(directory, 'summary.md')
    const artifacts = join(directory, 'artifacts')
    const reverseState = join(directory, 'reverse.json')
    const apk = join(directory, 'input.apk')
    writeFileSync(apk, 'fake')
    // 这三项验显式掉线恢复，不验每两秒的映射看护。只冻结执行器进程的 interval，
    // 不推进虚拟时间；setTimeout、ADB/Maestro 子进程和健康监测仍照常运行。
    // 避免慢机器上看护先补过一次，使“初始化 + 显式恢复”的计数混入第三次。
    const clock = join(directory, 'reverse-clock.mjs')
    if (clipboard)
      writeFileSync(
        clock,
        `
      import { appendFileSync } from 'node:fs';
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['setInterval'] });
      const schedule = mock.method(globalThis, 'setInterval');
      const clear = mock.method(globalThis, 'clearInterval');
      process.on('exit', () => appendFileSync(process.env.EVENTS, JSON.stringify({
        kind: 'reverse-clock',
        intervals: schedule.mock.calls.map(call => call.arguments[1]),
        cleared: clear.mock.callCount(),
      }) + '\\n'));
    `,
      )
    executable(
      join(android, 'platform-tools/adb'),
      `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.EVENTS, JSON.stringify({kind:'adb',args}) + '\\n');
      ${fakeHealthAdb}
      if (healthAdb(args)) {}
      else if (args[0] === 'devices') console.log('List of devices attached\\nemulator-5554\\tdevice\\n');
      else if (args.includes('get-state')) console.log(process.env.MODE === 'recovery-offline' ? 'offline' : 'device');
      else if (process.env.CLIPBOARD === '1' && args[2] === 'reverse') {
        const file = process.env.REVERSE_STATE;
        let rules = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
        if (args[3] === '--list') {
          if (process.env.RESTORE_REVERSE === '1') console.log(rules.map(pair => 'emulator ' + pair.join(' ')).join('\\n'));
        } else {
          rules = rules.filter(pair => pair[0] !== (args[3] === '--remove' ? args[4] : args[3]));
          if (args[3] !== '--remove') rules.push(args.slice(3,5));
          fs.writeFileSync(file, JSON.stringify(rules));
        }
      }
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
      if (process.env.CLIPBOARD === '1' && attempt === 1) fs.writeFileSync(process.env.REVERSE_STATE,'[]');
      const driverTimeout = mode === 'offline-then-driver-timeout' && attempt === 2;
      const command = driverTimeout ? {tapOnElement:{selector:{idRegex:'composer-send'}}} : mode === 'assert-offline' ? {assertConditionCommand:{}} : {launchAppCommand:{appId:'dev.litch.app'}};
      const error = {message:driverTimeout ? 'DEADLINE_EXCEEDED: waiting_for_connection' : 'test'};
      fs.writeFileSync(path.join(debug,'commands-test.json'),JSON.stringify([{command,metadata:{status:failed?'FAILED':'COMPLETED',error}}]));
      fs.writeFileSync(path.join(debug,'maestro.log'),mode === 'launch-without-feature' ? 'other failure' : 'java.io.IOException: device offline');
      fs.writeFileSync(args[args.indexOf('--output') + 1], failed ? '<testsuite><testcase><failure>first failure</failure></testcase></testsuite>' : '<testsuite/>');
      process.exit(failed ? 1 : 0);`,
    )
    const result = spawnSync(
      process.execPath,
      [
        ...(clipboard ? ['--import', pathToFileURL(clock).href] : []),
        join(repo, 'apps/mobile/scripts/e2e.mjs'),
        '--serial',
        'emulator-5554',
        '--apk',
        apk,
        '--only',
        join(repo, `apps/mobile/e2e/flows/mock/${clipboard ? '18-message-copy' : '01-home'}.yaml`),
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          HOME: directory,
          ANDROID_HOME: android,
          MAESTRO: maestro,
          MODE: mode,
          CLIPBOARD: clipboard ? '1' : '0',
          RESTORE_REVERSE: restoreReverse ? '1' : '0',
          REVERSE_STATE: reverseState,
          EVENTS: events,
          LITCH_E2E_ARTIFACTS: artifacts,
          GITHUB_STEP_SUMMARY: summary,
        },
        encoding: 'utf8',
        timeout: 20000,
      },
    )
    assert.equal(result.status, exitCode, `${result.stdout}\n${result.stderr}`)
    const rows = readFileSync(join(artifacts, 'flows.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
    assert.equal(rows.length, attempts)
    assert.equal(rows[0].status, 1)
    const flowName = clipboard ? '18-message-copy' : '01-home'
    assert.match(
      readFileSync(join(artifacts, `mock/${flowName}/attempt-1/junit.xml`), 'utf8'),
      /first failure/,
    )
    assert.ok(existsSync(join(artifacts, `mock/${flowName}/attempt-1/screen.png`)))
    const observed = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse)
    const mappings = observed.filter(
      (event) => event.args?.[2] === 'reverse' && event.args[3]?.startsWith('tcp:'),
    )
    if (clipboard) {
      assert.deepEqual(
        observed.filter((event) => event.kind === 'reverse-clock'),
        [{ kind: 'reverse-clock', intervals: [2000], cleared: 1 }],
        '映射看护仍注册并清理，但虚拟时钟没有触发它',
      )
      assert.equal(mappings.length, 2, '初始化一次，掉线后恢复同一条映射一次')
      assert.deepEqual(mappings[0].args, mappings[1].args)
      if (!restoreReverse) {
        const recovery = JSON.parse(
          readFileSync(
            join(artifacts, `mock/${flowName}/attempt-1/infrastructure-recovery.json`),
            'utf8',
          ),
        )
        assert.equal(recovery.recovered, false)
        assert.match(recovery.error, /reverse 未恢复完整/)
      }
    } else {
      assert.equal(mappings.length, 0, '普通 mock 不建立无关的 reverse 映射')
    }
    if (attempts === 2) {
      assert.equal(rows[1].attempt, 2)
      assert.match(rows[1].retryReason, /device offline/)
      assert.match(readFileSync(summary, 'utf8'), /基础设施重试：1 次/)
      const wait = observed.findIndex((event) => event.args?.includes('wait-for-device'))
      const verify = observed.findIndex((event) => event.args?.includes('--list'))
      const rerun = observed.findIndex((event) => event.kind === 'maestro' && event.attempt === 2)
      assert.ok(wait >= 0 && verify > wait && rerun > verify)
    }
    if (mode === 'offline-then-driver-timeout') {
      // 夜间先在 launchApp 掉线，第二次在点击时丢失 gRPC；不得追加第三次尝试或把整片记绿。
      assert.equal(rows[1].status, 1)
      assert.equal(observed.filter((event) => event.args?.includes('wait-for-device')).length, 1)
      const second = join(artifacts, `mock/${flowName}/attempt-2`)
      assert.match(
        readFileSync(join(second, 'commands-test.json'), 'utf8'),
        /waiting_for_connection/,
      )
      assert.equal(infrastructureRetryReason(second, 'dev.litch.app', true), null)
    }
  })
}

// 调用真实执行器的替身测试集中在本文件顺序跑，避免跨文件争用固定的 Maestro 7001 探测端口。
for (const mode of [
  'precheck-system',
  'precheck-dialog',
  'litch',
  'litch-child',
  'litch-after-success',
  'mixed',
  'unknown',
  'monitor-exit',
]) {
  test(`真实执行器拒绝 ANR/监测失效，不重试、不进入下一 flow：${mode}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'litch-health-test-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const android = join(directory, 'android')
    const executable = (file, source) => {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o755 })
    }
    const events = join(directory, 'events')
    writeFileSync(events, '')
    const apk = join(directory, 'app.apk')
    writeFileSync(apk, 'fake')
    executable(
      join(android, 'platform-tools/adb'),
      `${fakeHealthAdb}\nhealthAdb(process.argv.slice(2));`,
    )
    const maestro = join(directory, 'maestro')
    executable(
      maestro,
      `require('node:fs').appendFileSync(process.env.EVENTS, JSON.stringify({kind:'maestro'})+'\\n'); if (process.env.ANR_MODE === 'litch-after-success') process.exit(0); setInterval(()=>{},1000);`,
    )
    const artifacts = join(directory, 'artifacts')
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
        '--only',
        join(repo, 'apps/mobile/e2e/flows/mock/02-new-session.yaml'),
      ],
      {
        cwd: repo,
        timeout: 15000,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: directory,
          ANDROID_HOME: android,
          MAESTRO: maestro,
          EVENTS: events,
          ANR_MODE: mode,
          LITCH_E2E_ARTIFACTS: artifacts,
        },
      },
    )
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const calls = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(calls.length, mode.startsWith('precheck') ? 0 : 1)
    assert.ok(existsSync(join(artifacts, 'anr-first-failure.json')), result.stdout + result.stderr)
    const failure = JSON.parse(readFileSync(join(artifacts, 'anr-first-failure.json'), 'utf8'))
    assert.equal(
      failure.owner,
      mode.startsWith('litch')
        ? 'litch'
        : mode === 'precheck-system' || mode === 'mixed'
          ? 'system'
          : 'unknown',
    )
    assert.equal(failure.kind, mode === 'monitor-exit' ? 'monitor' : 'anr')
    if (mode === 'mixed') {
      const status = JSON.parse(readFileSync(join(artifacts, 'anr-status.json'), 'utf8'))
      assert.equal(status.owner, 'litch', '保留系统首败，但不能把混合故障归成基础设施')
      assert.deepEqual(status.owners, ['system', 'litch'])
    }
    if (mode.startsWith('precheck')) assert.ok(existsSync(join(artifacts, 'precheck-window.txt')))
  })
}

test('模拟执行器保留首次失败，下一 flow 通过也不变绿，不自动重跑', (t) => {
  const directory = temporary(t)
  const android = join(directory, 'android')
  const maestro = join(directory, 'maestro')
  const calls = join(directory, 'calls.jsonl')
  const summary = join(directory, 'summary.md')
  const artifacts = join(directory, 'artifacts')
  const apk = join(directory, 'input.apk')
  writeFileSync(apk, 'fake')
  executable(
    join(android, 'platform-tools/adb'),
    `
    ${fakeHealthAdb}
    if (healthAdb(process.argv.slice(2))) {}
    else if (process.argv[2] === 'devices') console.log('List of devices attached\\nemulator-5554\\tdevice\\n');
    else console.log('fake diagnostic');`,
  )
  executable(
    maestro,
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const file = args.at(-1);
    fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({file}) + '\\n');
    fs.writeFileSync(args[args.indexOf('--output') + 1], '<testsuite/>');
    process.exit(file.includes('01-home') ? 1 : 0);`,
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
      '--only',
      join(repo, 'apps/mobile/e2e/flows/mock/02-new-session.yaml'),
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        HOME: directory,
        ANDROID_HOME: android,
        MAESTRO: maestro,
        LITCH_E2E_ARTIFACTS: artifacts,
        GITHUB_STEP_SUMMARY: summary,
        FAKE_CALLS: calls,
      },
      encoding: 'utf8',
      timeout: 20000,
    },
  )
  assert.equal(result.status, 1, result.stderr)
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2)
  const rows = readFileSync(join(artifacts, 'flows.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.deepEqual(
    rows.map(({ attempt, status }) => [attempt, status]),
    [
      [1, 1],
      [1, 0],
    ],
  )
  for (const file of ['junit.xml', 'logcat.txt', 'screen.png', 'driver.txt']) {
    assert.ok(existsSync(join(artifacts, 'mock/01-home/attempt-1', file)))
  }
  assert.match(
    readFileSync(summary, 'utf8'),
    /首次失败：mock\/01-home.yaml（尝试 1）；基础设施重试：0 次；产品断言重试：0/,
  )
})

for (const buildStatus of [0, 1]) {
  test(`E2E 构建状态 ${buildStatus}：单次 Gradle 构建，收尾不停止其他 daemon`, (t) => {
    const directory = temporary(t)
    const events = join(directory, 'build-events.jsonl')
    const preload = join(directory, 'build-spawn.mjs')
    // 运行真实入口和 finally，只替换构建子进程，不能触碰真实 Android 工程或 daemon。
    writeFileSync(
      preload,
      `
      import childProcess from 'node:child_process';
      import { appendFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.spawnSync = (command, args, options) => {
        appendFileSync(process.env.EVENTS, JSON.stringify({ command, args }) + '\\n');
        if (command === 'npx') return { status: 0 };
        if (command === 'npm') return { status: Number(process.env.BUILD_STATUS) };
        throw new Error('不应启动其他同步命令：' + command);
      };
      syncBuiltinESMExports();
    `,
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(preload).href,
        join(repo, 'apps/mobile/scripts/e2e.mjs'),
        '--build',
        '--apk',
        join(directory, 'missing.apk'),
        '--only',
        'mock',
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          HOME: directory,
          GRADLE_USER_HOME: join(directory, 'shared-gradle'),
          EVENTS: events,
          BUILD_STATUS: String(buildStatus),
          GITHUB_STEP_SUMMARY: '',
          LITCH_E2E_ARTIFACTS: join(directory, 'artifacts'),
        },
        encoding: 'utf8',
        timeout: 20000,
      },
    )
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stdout, buildStatus === 0 ? /没有安装包/ : /android:release.*失败/)
    const commands = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(commands, [
      {
        command: 'npx',
        args: ['expo', 'prebuild', '--platform', 'android', '--clean', '--no-install'],
      },
      { command: 'npm', args: ['run', 'android:release', '--', '--max-workers=4', '--no-daemon'] },
    ])
    // npm 将 -- 后的参数追加到整个脚本末尾，必须仍落到 Gradle 上。
    const mobilePackage = JSON.parse(readFileSync(join(repo, 'apps/mobile/package.json'), 'utf8'))
    assert.match(mobilePackage.scripts['android:release'], /\.\/gradlew assembleRelease$/)
  })
}
