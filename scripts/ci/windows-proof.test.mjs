import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import { checkPlan } from './check-catalog.mjs'
import { coreTestFiles } from './core-tests.mjs'
import { fixtureWindowsProof } from './mac-proof-fixture.mjs'
import { hasWindowsCoverage } from './windows-proof.mjs'

test('核心集合按源码选择：跨平台逻辑保留，两条原生入口不混入便携集合', () => {
  const names = readdirSync(new URL('../../packages/core/test/', import.meta.url))
  const portable = coreTestFiles(names, 'portable')
  const native = coreTestFiles(names, 'windows-native')
  assert.ok(portable.includes('machine-windows.test.mjs'))
  assert.deepEqual(native, ['machine-rpc.windows-test.mjs', 'machine-scripts.windows-test.mjs'])
  assert.ok(native.every((name) => !portable.includes(name)))
  assert.ok(!portable.includes('machine-windows-rpc.test.mjs'))
  assert.throws(() => coreTestFiles([], 'windows-native'), /不能为空/)
  assert.throws(() => coreTestFiles(names, 'unknown'), /未知/)
})

test('Windows 工作流实际执行共享原生集合并上传逐 attempt 的证明', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/windows.yml', import.meta.url), 'utf8'),
  )
  const steps = workflow.jobs.windows.steps
  const build = steps.findIndex((step) => step.run === 'npm run build --prefix packages/core')
  const check = steps.findIndex(
    (step) => step.run === 'node scripts/ci/run-checks.mjs windows-native --built',
  )
  assert.ok(build >= 0 && check > build)
  assert.equal(steps[check].env.CI_CHECK_REPORT, '.artifacts/windows-native-checks/checks.json')
  const upload = steps.find(
    (step) => step.with?.name === 'windows-native-proof-${{ github.run_attempt }}',
  )
  assert.equal(upload.with.path, steps[check].env.CI_CHECK_REPORT)
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.deepEqual(checkPlan(['windows-native']).checks, [
    {
      id: 'client:test:windows-native',
      command: ['node', 'scripts/ci/core-tests.mjs', 'windows-native'],
    },
  ])
})

test('Windows 证明拒绝缺失、平台/来源错误、跳过与空测试，不能用 Linux 通过替代', () => {
  const full = {
    repository: 'test/litch',
    sha: 'a'.repeat(40),
    runId: 42,
    attempt: 2,
    runCi: true,
    jobs: { gate: 'success' },
  }
  full.windowsProof = fixtureWindowsProof(full)
  assert.equal(hasWindowsCoverage(full), true)
  for (const alter of [
    (f) => {
      delete f.windowsProof
    },
    (f) => {
      f.jobs.gate = 'failure'
    },
    (f) => {
      f.windowsProof.artifact.id = 0
    },
    (f) => {
      f.windowsProof.artifact.jobId = 0
    },
    (f) => {
      f.windowsProof.artifact.digest = 'bad'
    },
    (f) => {
      f.windowsProof.artifact.attempt = 3
    },
    (f) => {
      f.windowsProof.artifact.name = 'linux-checks-ci-client-2'
    },
    (f) => {
      f.windowsProof.proof.platform = 'linux'
    },
    (f) => {
      f.windowsProof.proof.sha = 'b'.repeat(40)
    },
    (f) => {
      f.windowsProof.proof.runId = '43'
    },
    (f) => {
      f.windowsProof.proof.attempt = 1
    },
    (f) => {
      f.windowsProof.proof.complete = false
    },
    (f) => {
      f.windowsProof.proof.results = []
    },
    (f) => {
      f.windowsProof.proof.results[0].tests.skipped = 1
    },
    (f) => {
      f.windowsProof.proof.results[0].tests.tests = 0
    },
    (f) => {
      f.windowsProof.proof.plan.checks[0].command = ['true']
    },
  ]) {
    const bad = structuredClone(full)
    alter(bad)
    assert.equal(hasWindowsCoverage(bad), false)
  }
  assert.equal(hasWindowsCoverage({ runCi: false, windowsProof: null }), true)
  assert.equal(hasWindowsCoverage({ ...full, runCi: false }), false)
})
