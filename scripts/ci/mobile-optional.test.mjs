import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { fullJobs, isCompleteFull } from '../full-proof.mjs'
import { checkManifest } from './check-mobile-apk.mjs'
import { fixtureLinuxProofs, fixtureMacProof } from './mac-proof-fixture.mjs'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const full = read('.github/workflows/full.yml')
const job = (name) =>
  full.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))?.[1] ?? ''

test('E2E 必须手动显式开启且选中 mobile；默认、schedule、非手机领域均不运行', () => {
  assert.equal(
    (full.match(/mobile-e2e:\n\s+(?:description:.*\n\s+)?type: boolean\n\s+default: false/g) ?? [])
      .length,
    2,
  )
  const condition = job('mobile').match(/if: \$\{\{ (.*) \}\}/)?.[1]
  assert.ok(condition)
  for (const event of ['schedule', 'workflow_dispatch', 'push']) {
    for (const enabled of [undefined, false, true]) {
      for (const domains of ['', '["mobile"]', '["client"]']) {
        const actual = runInNewContext(
          condition.replaceAll('inputs.mobile-e2e', 'inputs["mobile-e2e"]'),
          {
            github: { event_name: event },
            inputs: { 'mobile-e2e': enabled, domains },
            fromJSON: JSON.parse,
            contains: (list, value) => list.includes(value),
          },
        )
        assert.equal(
          Boolean(actual),
          event === 'workflow_dispatch' && enabled === true && domains !== '["client"]',
        )
      }
    }
  }
  assert.match(job('mobile'), /shard: \[1, 2, 3\]/)
  for (const marker of [
    'mobile-disk.sh',
    'android-health.mjs mark-start',
    'EXPECTED_APK_HASH',
    'LITCH_E2E_DIAGNOSTICS',
  ])
    assert.ok(job('mobile').includes(marker))
})

test('默认 Full 保留手机单测/类型/APK 校验，report 和证明不依赖可选三片', () => {
  const build = job('mobile-build')
  assert.doesNotMatch(build, /inputs\.mobile-e2e/)
  for (const command of [
    'npm run mobile:test',
    'npm run typecheck --prefix apps/mobile',
    'npm run android:release',
    'check-mobile-apk.mjs',
    'apk.mjs seal',
    'apk.mjs verify',
  ])
    assert.ok(build.includes(command), command)
  const needs = job('report')
    .match(/needs: \[([^\]]+)\]/)[1]
    .split(',')
    .map((s) => s.trim())
  assert.ok(needs.includes('mobile-build'))
  assert.ok(!needs.includes('mobile'))
  // 三个原生领域由 native 的逐检查证明合成；client-unit 是 run-ci=false 的 Linux 来源。
  assert.deepEqual(needs, [
    'source',
    'gate',
    'adapters',
    'native',
    'client-unit',
    'computer-use-windows',
    'dsh',
    'opencode',
    'real-engines',
    'mobile-build',
  ])
  assert.ok(!fullJobs.includes('mobile'))
  for (const name of ['native', 'computer-use', 'client', 'client-engines', 'mobile-build'])
    assert.ok(fullJobs.includes(name))
  assert.match(job('report'), /node scripts\/ci\/read-check-proofs.mjs/)
  assert.match(job('client-unit'), /uses: \.\/.github\/workflows\/linux-desktop.yml/)
  assert.match(job('native'), /uses: \.\/.github\/workflows\/mac-native.yml/)
  const sha = 'a'.repeat(40)
  const run = {
    id: 10,
    run_attempt: 1,
    path: '.github/workflows/full.yml',
    event: 'schedule',
    status: 'completed',
    conclusion: 'success',
    head_sha: sha,
  }
  const proof = {
    schema: 1,
    repository: 'test/litch',
    runId: 10,
    attempt: 1,
    event: 'schedule',
    workflowSha: sha,
    sha,
    domains: '',
    runCi: true,
    jobs: Object.fromEntries(fullJobs.map((name) => [name, 'success'])),
  }
  proof.macProof = fixtureMacProof(proof)
  proof.linuxProofs = fixtureLinuxProofs(proof)
  assert.equal(isCompleteFull(run, proof, sha, 'test/litch'), true)
  assert.equal(isCompleteFull(run, { ...proof, macProof: null }, sha, 'test/litch'), false)
  assert.equal(isCompleteFull(run, { ...proof, linuxProofs: {} }, sha, 'test/litch'), false)
  assert.equal(
    isCompleteFull(
      run,
      { ...proof, jobs: { ...proof.jobs, 'mobile-build': 'failure' } },
      sha,
      'test/litch',
    ),
    false,
  )
})

test('旧夜间自动 issue 入口及脚本移除；发版仍排除 mobile E2E', () => {
  for (const path of [
    '.github/workflows/nightly-mobile.yml',
    'scripts/ci/release-nightly-mobile.mjs',
  ])
    assert.equal(existsSync(new URL(`../../${path}`, import.meta.url)), false)
  const gate = read('.github/workflows/gate.yml')
  assert.doesNotMatch(gate, /mobile-e2e:/)
  assert.match(gate, /npm run typecheck --prefix apps\/mobile/)
  assert.match(
    read('scripts/ci-impact.mjs'),
    /releaseDomains = domains\.filter\(\(domain\) => domain !== 'mobile'\)/,
  )
  assert.match(read('.github/workflows/release.yml'), /apksigner.*verify|"\$apksigner" verify/)
})

test('APK manifest 必须匹配身份、版本、启动 Activity 和模拟器 ABI', () => {
  const expected = { package: 'dev.litch.app', version: '0.29.0' }
  const badging =
    "package: name='dev.litch.app' versionCode='29' versionName='0.29.0'\nlaunchable-activity: name='dev.litch.app.MainActivity'\nnative-code: 'x86_64'"
  checkManifest(badging, expected)
  for (const [from, to] of [
    ['dev.litch.app', 'other.app'],
    ["versionCode='29'", "versionCode='0'"],
    ['0.29.0', '0.28.0'],
    ['launchable-activity:', 'activity:'],
    ['x86_64', 'arm64-v8a'],
  ])
    assert.throws(() => checkManifest(badging.replace(from, to), expected))
  assert.throws(() => checkManifest('', expected))
  assert.match(read('scripts/ci/check-mobile-apk.mjs'), /apksigner.*\['verify'/)
})
