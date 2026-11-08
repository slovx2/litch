import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPlan } from './check-catalog.mjs'
import { comparableCoverage, compareChecks } from './compare-checks.mjs'
import { cliPackages } from './install-test-clis.mjs'
import { coverage, executeChecks, isolatedEnvironment } from './run-checks.mjs'

test('CLI安装复用原精确基线，ACP共用隔离OpenCode，拒绝版本范围', () => {
  const versions = {
    codexVerified: ['0.163.0'],
    dshMinimum: '0.2.0-rc.2',
    opencodeVerified: ['1.18.33'],
  }
  const specs = cliPackages(versions)
  assert.equal(specs.CLAUDE.version, '2.1.282')
  assert.equal(specs.ACP, specs.OPENCODE)
  assert.throws(() => cliPackages({ ...versions, dshMinimum: '^0.2.0' }))
})

test('多领域复用首回合/原生工具检查，不允许未知、空或重复领域', () => {
  const plan = checkPlan(['desktop-required', 'real-engines'])
  assert.equal(plan.checks.filter((check) => check.id === 'first-turn').length, 1)
  assert.equal(plan.checks.filter((check) => check.id === 'probe-engines-kit:test').length, 1)
  for (const suite of ['desktop-required', 'real-engines']) {
    const ids = checkPlan([suite]).checks.map((check) => check.id)
    assert.ok(ids.indexOf('probe-engines-kit:test') < ids.indexOf('first-turn'))
  }
  assert.ok(plan.checks.some((check) => check.id === 'manager-fixture'))
  assert.deepEqual(plan.clis, ['CODEX', 'CLAUDE', 'DSH', 'OPENCODE', 'ACP'])
  for (const names of [[], ['typo'], ['dsh', 'dsh']]) assert.throws(() => checkPlan(names))
})

test('可移植子集明确排除浏览器，桌面集合包含更新回归与原有检查', () => {
  const full = checkPlan(['desktop-unit']).checks.map((check) => check.id)
  const portable = checkPlan(['desktop-portable-unit']).checks.map((check) => check.id)
  assert.equal(full.length, 10)
  assert.ok(full.includes('desktop:test:updater'))
  assert.ok(full.includes('desktop:test:browser'))
  assert.deepEqual(
    portable,
    full.filter((id) => id !== 'desktop:test:browser'),
  )
})

test('引擎工具子集不冒充完整领域，与关键Mac集合组合恰好覆盖原检查', () => {
  const ids = (names) =>
    checkPlan(names)
      .checks.map((check) => check.id)
      .sort()
  assert.deepEqual(
    ids(['desktop-required', 'real-engine-tools']),
    ids(['desktop-required', 'real-engines']),
  )
  assert.ok(!ids(['real-engine-tools']).includes('first-turn'))
  assert.ok(ids(['real-engines']).includes('first-turn'))
})

test('读取真实 reporter 形态，保留重名用例、跳过和失败数量，去除耗时与ANSI', () => {
  assert.deepEqual(
    coverage(
      '\u001b[32m✔ 回合 (12.34ms)\u001b[0m\n✔ 回合 (2ms)\nℹ tests 2\nℹ fail 0\nℹ skipped 0\nℹ cancelled 0',
    ),
    {
      tests: 2,
      fail: 0,
      skipped: 0,
      cancelled: 0,
      names: ['回合', '回合'],
    },
  )
  assert.deepEqual(
    coverage('# Subtest: 回合\nok 1 - 回合 # SKIP\n# tests 1\n# fail 0\n# skipped 1'),
    {
      tests: 1,
      fail: 0,
      skipped: 1,
      cancelled: 0,
      names: ['回合'],
    },
  )
})

test('检查环境隔离个人身份、模型凭据与真实设备，保留显式隔离CLI', () => {
  const env = isolatedEnvironment(
    {
      HOME: '/personal',
      CODEX_HOME: '/personal/codex',
      CLAUDE_CONFIG_DIR: '/personal/claude',
      GH_TOKEN: 'fake',
      OPENAI_API_KEY: 'fake',
      ANTHROPIC_API_KEY: 'fake',
      OPENROUTER_API_KEY: 'fake-personal-provider',
      DEEPSEEK_API_KEY: 'fake-personal-provider',
      CUSTOM_AUTH_TOKEN: 'fake-personal-provider',
      LITCH_DEVICE_SOCKET: '/personal/device',
      CHA_CODEX_CLI: '/isolated/codex',
      NODE_TEST_CONTEXT: 'child',
      NODE_OPTIONS: '--import /personal/hook',
    },
    '/isolated/home',
  )
  assert.equal(env.HOME, '/isolated/home')
  assert.equal(env.CODEX_HOME, '/isolated/home/.codex')
  assert.equal(env.CHA_CODEX_CLI, '/isolated/codex')
  for (const key of [
    'GH_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY',
    'CUSTOM_AUTH_TOKEN',
    'LITCH_DEVICE_SOCKET',
    'NODE_TEST_CONTEXT',
    'NODE_OPTIONS',
  ])
    assert.equal(env[key], undefined)
})

test('缺CLI、子进程失败、中断或跳过均停止；失败后不会补跑或重试', async () => {
  const plan = checkPlan(['desktop-required'])
  let calls = 0
  const env = Object.fromEntries(plan.clis.map((cli) => [`CHA_${cli}_CLI`, process.execPath]))
  await assert.rejects(
    executeChecks(plan, {
      env: {},
      execute: () => {
        calls++
      },
    }),
    /缺少隔离/,
  )
  assert.equal(calls, 0)
  for (const result of [
    { code: 1, output: '' },
    { code: 0, signal: 'SIGTERM', output: '' },
    { code: 0, output: 'ℹ skipped 1' },
  ]) {
    calls = 0
    await assert.rejects(
      executeChecks(plan, {
        env,
        built: true,
        execute: async () => {
          calls++
          return result
        },
      }),
    )
    assert.equal(calls, 1)
  }
})

test('共享执行只构建一次，产出每项结果，空Node集合不能当通过', async () => {
  const plan = checkPlan(['client-engines'])
  const env = Object.fromEntries(plan.clis.map((cli) => [`CHA_${cli}_CLI`, process.execPath]))
  const commands = []
  const result = await executeChecks(plan, {
    env,
    execute: async (command) => {
      commands.push(command)
      return { code: 0, output: '✔ 用例 (1ms)\nℹ tests 1\nℹ fail 0\nℹ skipped 0\nℹ cancelled 0' }
    },
  })
  assert.equal(commands.filter((command) => command.includes('client:build')).length, 1)
  assert.equal(result.length, 2)
  await assert.rejects(
    executeChecks(plan, { env, built: true, execute: async () => ({ code: 0, output: '' }) }),
    /没有用例清单/,
  )
})

test('同SHA双平台正例；缺检查、错来源、跳过、用例差异和清单篡改均拒绝', () => {
  const names = ['opencode']
  const plan = checkPlan(names)
  const left = {
    schema: 1,
    complete: true,
    repository: 'example/repo',
    sha: 'a'.repeat(40),
    runId: '123',
    attempt: 1,
    platform: 'darwin',
    arch: 'arm64',
    node: 'v24.21.0',
    versions: {
      codexVerified: ['0.163.0'],
      dshMinimum: '0.2.0-rc.2',
      opencodeVerified: ['1.18.33'],
    },
    clis: [{ id: 'OPENCODE', package: 'opencode-ai', version: '1.18.33' }],
    plan,
    results: [
      { id: 'opencode:unit', code: 0, signal: null, tests: coverage('✔ 用例 (1ms)\nℹ tests 1') },
    ],
  }
  const right = { ...structuredClone(left), platform: 'linux', arch: 'x64' }
  assert.equal(compareChecks(left, right, names).nodeTests, 1)
  for (const alter of [
    (proof) => {
      proof.complete = false
    },
    (proof) => {
      proof.sha = 'b'.repeat(40)
    },
    (proof) => {
      proof.runId = '124'
    },
    (proof) => {
      proof.attempt = 2
    },
    (proof) => {
      proof.results = []
    },
    (proof) => {
      proof.results[0].tests.skipped = 1
    },
    (proof) => {
      proof.results[0].tests.names = ['另一用例']
    },
    (proof) => {
      proof.plan.checks[0].command = ['true']
    },
    (proof) => {
      proof.clis = []
    },
    (proof) => {
      proof.results[0].tests = coverage('')
    },
  ]) {
    const changed = structuredClone(right)
    alter(changed)
    assert.throws(() => compareChecks(left, changed, names))
  }
})

test('末项失败只允许比较已完成子集，原始失败/来源保留，不能冒充整轮等价', () => {
  const names = ['opencode', 'client-engines']
  const versions = {
    codexVerified: ['0.163.0'],
    dshMinimum: '0.2.0-rc.2',
    opencodeVerified: ['1.18.33'],
  }
  const plan = checkPlan(names)
  const specs = cliPackages(versions)
  const left = {
    schema: 1,
    complete: false,
    repository: 'example/repo',
    sha: 'a'.repeat(40),
    runId: '123',
    attempt: 1,
    platform: 'darwin',
    node: 'v24.21.0',
    versions,
    plan,
    clis: plan.clis.map((id) => ({ id, package: specs[id].name, version: specs[id].version })),
    results: plan.checks.map((check, index) => ({
      id: check.id,
      code: index === 2 ? 1 : 0,
      signal: null,
      tests: coverage('✔ 用例 (1ms)\nℹ tests 1'),
    })),
  }
  const right = { ...structuredClone(left), platform: 'linux' }
  const before = JSON.stringify([left, right])
  const result = compareChecks(left, right, names, { only: ['opencode'] })
  assert.equal(result.scope, 'selected-subsets')
  assert.deepEqual(result.sourceComplete, [false, false])
  assert.equal(JSON.stringify([left, right]), before)
  assert.throws(() => compareChecks(left, right, names))
  assert.throws(() => compareChecks(left, right, names, { only: names }))
  assert.throws(() => compareChecks(left, right, names, { only: ['client-engines'] }))
  assert.throws(() => compareChecks(left, right, names, { only: ['dsh'] }))
  for (const alter of [
    (p) => {
      p.results[0].tests.skipped = 1
    },
    (p) => {
      p.results[0].code = 1
    },
    (p) => {
      p.results = []
    },
    (p) => {
      p.results.push(p.results[0])
    },
    (p) => {
      p.plan.checks[0].command = ['true']
    },
    (p) => {
      p.attempt = 2
    },
    (p) => {
      p.sha = 'b'.repeat(40)
    },
    (p) => {
      p.results[0].tests.names = ['不同用例']
    },
  ]) {
    const changed = structuredClone(right)
    alter(changed)
    assert.throws(() => compareChecks(left, changed, names, { only: ['opencode'] }))
  }
})

test('日志测试只消除已核实入口的随机临时前缀，原始记录/数量/失败语义不变', () => {
  const make = (name, id = 'desktop:test:log-file') => ({
    id,
    tests: { tests: 1, fail: 0, skipped: 0, cancelled: 0, names: [name] },
  })
  const mac = make(
    '/var/folders/y3/p6x0rn5562l5qyxy7x6jqrsc0000gn/T/litch-log-tests-ziDy8M/log-file.test.mjs',
  )
  const linux = make('/tmp/litch-log-tests-xqthzr/log-file.test.mjs')
  const original = JSON.stringify(mac)
  assert.deepEqual(comparableCoverage(mac), comparableCoverage(linux))
  assert.equal(JSON.stringify(mac), original)
  for (const changed of [
    make('/tmp/litch-log-tests-xqthzr/another.test.mjs'),
    make('/tmp/other-tests-xqthzr/log-file.test.mjs'),
    make('/tmp/litch-log-tests-xqthzr/log-file.test.mjs', 'desktop:test:browser'),
    { ...linux, tests: { ...linux.tests, skipped: 1 } },
    { ...linux, tests: { ...linux.tests, fail: 1 } },
    { ...linux, tests: { ...linux.tests, tests: 2 } },
  ])
    assert.notDeepEqual(comparableCoverage(mac), comparableCoverage(changed))
})

test('原生Codex诊断只映射同仓库隔离CLI的宿主前缀，版本与安装路径仍严格比较', () => {
  const make = (root, version = '0.163.0', repo = 'litch') => ({
    id: 'native-codex',
    tests: coverage(
      `✔ 启用后可用：Codex ${version}（${root}/runner/work/${repo}/${repo}/.artifacts/host-codex/node_modules/.bin/codex），权限预设 :read-only`,
    ),
  })
  const mac = comparableCoverage(make('/Users'), 'slovx2/litch')
  assert.deepEqual(mac, comparableCoverage(make('/home'), 'slovx2/litch'))
  for (const changed of [
    make('/home', '0.164.0'),
    make('/home', '0.163.0', 'other'),
    make('/unrecognized'),
  ]) {
    assert.notDeepEqual(mac, comparableCoverage(changed, 'slovx2/litch'))
  }
})
