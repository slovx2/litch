import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { acceptedStep, uploadStep } from '../../apps/desktop/scripts/macos-checkpoint.mjs'
import { affectedDomains, releaseDomains, releaseImpact } from '../ci-impact.mjs'
import { fullJobs, hasReleaseCoverage, isCompleteReleaseFull } from '../full-proof.mjs'
import { checkNightly, checkVersion } from '../release-policy.mjs'
import { artifactKinds, writeProvenance } from '../release-provenance.mjs'
import { fixtureMacProof } from './mac-proof-fixture.mjs'
import { checkApkManifest } from './release-apk.mjs'
import { archiveNames, extractFlat, validateArtifact } from './release-artifacts.mjs'
import {
  checkGate,
  checkJob,
  chooseArtifact,
  inventory,
  policyVersion,
  requiredPackages,
  sealCandidate,
  sourceRun,
  verifyCandidate,
  writeJson,
} from './release-candidate.mjs'
import { mobileFailure } from './release-nightly-mobile.mjs'
import { existingCandidate } from './release-preflight.mjs'
import { checkAssets, checkDraft, promote, promotionInputs } from './release-promote.mjs'

const sha = 'a'.repeat(40)
const digest = `sha256:${'b'.repeat(64)}`
const policy = 'c'.repeat(64)
const context = { repository: 'fixture/repo', sha, runId: '42', attempt: 3, version: '1.2.3' }
const checkpoint = {
  schema: 1,
  state: 'Accepted',
  repository: context.repository,
  sha,
  run: '42',
  attempt: 1,
  version: context.version,
  arch: 'arm64',
  submission: '12345678-1234-1234-1234-123456789abc',
  team: 'ABCDEFGHIJ',
  validatedAttempt: 1,
  files: { 'signed-app.zip': 'a'.repeat(64), 'Litch-1.2.3-macos-arm64.dmg': 'b'.repeat(64) },
  artifact: { id: 88, name: 'macos-notarized-1', digest, attempt: 1 },
}
const run = {
  repository: { full_name: context.repository },
  id: 42,
  run_attempt: 3,
  head_sha: sha,
  path: '.github/workflows/release.yml',
  event: 'workflow_dispatch',
  status: 'completed',
  conclusion: 'success',
}
const artifact = {
  id: 99,
  name: 'verified-candidate-3',
  digest,
  expired: false,
  workflow_run: { id: 42, head_sha: sha },
}
const env = {
  GITHUB_REPOSITORY: context.repository,
  SOURCE_RUN: '42',
  SOURCE_ATTEMPT: '3',
  CANDIDATE_SHA: sha,
  ARTIFACT_ID: '99',
  ARTIFACT_DIGEST: digest,
  TAG: 'v1.2.3',
  PROMOTE_MODE: 'verify',
}
function temp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-release-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function fixture(t) {
  const dir = temp(t)
  const artifacts = {}
  let id = 10
  for (const kind of artifactKinds) {
    const source = temp(t)
    for (const name of requiredPackages(context.version)[kind])
      writeFileSync(join(source, name), name)
    writeProvenance(source, kind, sha, '42', '1', kind === 'desktop-macos' ? checkpoint : undefined)
    cpSync(source, dir, { recursive: true })
    artifacts[kind] = { id: id++, name: `${kind}-1`, digest, attempt: 1, jobId: id + 100 }
  }
  for (const kind of ['gate-proof', 'full-proof'])
    artifacts[kind] = { id: id++, name: `${kind}-3`, digest, attempt: 3, jobId: id + 100 }
  const gate = {
    schema: 2,
    repository: context.repository,
    policy: policyVersion,
    mobileStatic: 'success',
    sha,
    run: '42',
    attempt: '3',
    domains: releaseDomains,
    baseline: { sha: null, run: null },
    conclusion: 'success',
    fullArtifact: artifacts['full-proof'],
    createdAt: new Date().toISOString(),
  }
  const full = {
    schema: 1,
    repository: context.repository,
    runId: 42,
    attempt: 3,
    sha,
    workflowSha: sha,
    event: 'workflow_dispatch',
    runCi: true,
    domains: JSON.stringify(releaseDomains),
    jobs: Object.fromEntries(
      fullJobs.map((job) => [job, job.startsWith('mobile') ? 'skipped' : 'success']),
    ),
  }
  full.macProof = fixtureMacProof(full)
  writeJson(join(dir, 'gate-proof.json'), gate)
  writeJson(join(dir, 'full-proof.json'), full)
  const manifest = await sealCandidate(dir, context, artifacts, policy)
  writeFileSync(join(dir, 'litch-update.json'), '{}')
  writeFileSync(join(dir, 'Litch-SHA256SUMS.txt'), 'fixture')
  manifest.files = await inventory(dir)
  writeJson(join(dir, 'candidate.json'), manifest)
  return { dir, manifest, gate, full, artifacts }
}

test('跨 run 晋级可复用源 run 早期成功包，验证 attempt 与打包 attempt 不伪装相同', async (t) => {
  const { dir, manifest } = await fixture(t)
  assert.equal((await verifyCandidate(dir, context, policy)).artifacts.android.attempt, 1)
  assert.equal(manifest.attempt, 3)
  for (const changed of [
    { sha: 'd'.repeat(40) },
    { runId: '43' },
    { attempt: 2 },
    { version: '1.2.4' },
  ])
    await assert.rejects(verifyCandidate(dir, { ...context, ...changed }, policy), /candidate/)
  await assert.rejects(verifyCandidate(dir, context, 'changed'), /策略已变/)
  // 完整候选并不依赖旧夜间；48 小时约束仅作用于增量基线。
  await verifyCandidate(dir, context, policy, Date.now() + 49 * 3600_000)
  writeFileSync(join(dir, 'Litch-1.2.3-macos-arm64.zip'), '篡改')
  await assert.rejects(verifyCandidate(dir, context, policy), /hash/)
})

test('无签名、缺文件、多余文件、错 attempt 和错误平台清单拒绝晋级', async (t) => {
  for (const mutation of ['unsigned', 'missing', 'extra', 'attempt', 'kind']) {
    const { dir, manifest } = await fixture(t)
    if (mutation === 'missing') rmSync(join(dir, 'Litch-1.2.3-macos-arm64.zip'))
    else if (mutation === 'extra') writeFileSync(join(dir, 'extra.zip'), 'unknown')
    else {
      const path = join(dir, 'release-provenance-android.json')
      const proof = JSON.parse(readFileSync(path, 'utf8'))
      if (mutation === 'unsigned') proof.signing = 'debug'
      if (mutation === 'attempt') proof.attempt = '2'
      if (mutation === 'kind') proof.kind = 'cha'
      writeJson(path, proof)
      // 即使有人重算外层清单，内层契约仍拒绝。
      manifest.files = await inventory(dir, ['candidate.json'])
      writeJson(join(dir, 'candidate.json'), manifest)
    }
    await assert.rejects(verifyCandidate(dir, context, policy))
  }
})

test('source 必须同仓同工作流同 SHA，当前 attempt 全绿，旧成功不可盖过新失败', () => {
  sourceRun(run, context)
  for (const patch of [
    { conclusion: 'failure' },
    { run_attempt: 4 },
    { head_sha: 'd'.repeat(40) },
    { path: '.github/workflows/gate.yml' },
    { event: 'push' },
    { repository: { full_name: 'other/repo' } },
  ])
    assert.throws(() => sourceRun({ ...run, ...patch }, context))
  const job = {
    id: 101,
    name: 'android',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
  }
  assert.equal(checkJob([job], 'android', 1), 101)
  for (const patch of [{ conclusion: 'failure' }, { run_attempt: 2 }, { status: 'in_progress' }])
    assert.throws(() => checkJob([{ ...job, ...patch }], 'android', 1))
})

test('只重跑 Gate 汇总可以绑定较早成功的 Full attempt，必须保留确切 artifact', async (t) => {
  const { gate, full } = await fixture(t)
  const old = { ...full, attempt: 1 }
  old.macProof = fixtureMacProof(old)
  checkGate({ ...gate, fullArtifact: { ...gate.fullArtifact, attempt: 1 } }, old, context)
  assert.throws(() => checkGate(gate, old, context), /full attempt/)
})

test('artifact 精确绑定 ID/名字/run/SHA/digest/有效期，不回退旧同名成功', () => {
  const expected = { run: 42, sha, name: artifact.name, digest }
  validateArtifact(artifact, expected)
  for (const patch of [
    { expired: true },
    { digest: null },
    { digest: `sha256:${'c'.repeat(64)}` },
    { workflow_run: { id: 43, head_sha: sha } },
    { name: 'verified-candidate-2' },
  ])
    assert.throws(() => validateArtifact({ ...artifact, ...patch }, expected))
  const pack = { ...artifact, name: 'android-1' }
  assert.equal(chooseArtifact([pack], 'android', context).attempt, 1)
  assert.throws(() => chooseArtifact([pack, { ...pack, id: 100 }], 'android', context), /多义/)
  assert.throws(
    () => chooseArtifact([pack, { ...pack, name: 'android-2', expired: true }], 'android', context),
    /有效期/,
  )
})

test('真实 ZIP 解包只接受平铺唯一文件，不允许路径穿越或覆盖', async (t) => {
  const source = temp(t)
  writeFileSync(join(source, 'proof.json'), '{}')
  const archive = join(temp(t), 'test.zip')
  execFileSync('zip', ['-q', archive, 'proof.json'], { cwd: source })
  assert.deepEqual(archiveNames(archive), ['proof.json'])
  const out = temp(t)
  await extractFlat(archive, out)
  assert.equal(readFileSync(join(out, 'proof.json'), 'utf8'), '{}')
  await assert.rejects(extractFlat(archive, out), /冲突/)
  const bad = join(temp(t), 'bad.zip')
  execFileSync('zip', ['-q', bad, `../${basename(source)}/proof.json`], { cwd: source })
  assert.throws(() => archiveNames(bad), /路径/)
})

test('D-48：无基线/共享/手机变更都排除模拟器，单测/类型证明仍必需', async (t) => {
  for (const path of [
    'apps/mobile/src/main.ts',
    'packages/core/src/main.mts',
    '.github/workflows/full.yml',
  ]) {
    for (const trustedBase of [true, false]) {
      const result = releaseImpact(affectedDomains([path], { trustedBase }))
      assert.ok(!result.domains.includes('mobile'))
      if (!trustedBase) assert.deepEqual(result.domains, releaseDomains)
    }
  }
  const { gate, full } = await fixture(t)
  assert.ok(hasReleaseCoverage(full))
  assert.ok(isCompleteReleaseFull(run, full, sha, context.repository))
  assert.throws(() => checkGate({ ...gate, mobileStatic: 'failure' }, full, context), /手机类型/)
  assert.throws(
    () => checkGate({ ...gate, domains: [...releaseDomains, 'mobile'] }, full, context),
    /domains/,
  )
})

test('D-48：夜间仅手机红不挡；非手机红、未知证明、blocker 仍挡；mobile-only 不算完整', async (t) => {
  const { full } = await fixture(t)
  const nightly = {
    ...run,
    event: 'schedule',
    path: '.github/workflows/full.yml',
    conclusion: 'failure',
  }
  const proof = {
    ...full,
    domains: '',
    event: 'schedule',
    jobs: { ...full.jobs, mobile: 'failure', 'mobile-build': 'success' },
  }
  const qualifies = isCompleteReleaseFull(nightly, proof, sha, context.repository)
  assert.equal(qualifies, true)
  assert.equal(hasReleaseCoverage({ ...proof, domains: undefined }), false)
  assert.equal(
    isCompleteReleaseFull(
      nightly,
      { ...proof, jobs: { ...proof.jobs, mobile: 'success' } },
      sha,
      context.repository,
    ),
    false,
  )
  const input = { nightly, sha, blockers: [], releaseCoveragePassed: qualifies }
  assert.match(checkNightly(input), /仅手机/)
  assert.throws(
    () => checkNightly({ ...input, blockers: [{ html_url: 'blocker' }] }),
    /release-blocker/,
  )
  for (const changed of [
    { domains: '["mobile"]' },
    { runCi: false },
    { jobs: { ...proof.jobs, client: 'failure' } },
    { jobs: { ...proof.jobs, gate: 'failure' } },
  ])
    assert.equal(
      isCompleteReleaseFull(nightly, { ...proof, ...changed }, sha, context.repository),
      false,
    )
  assert.throws(() => checkNightly({ ...input, releaseCoveragePassed: false }), /须同 SHA/)
})

test('增量基线过期不能用仍存在的 artifact 放行', async (t) => {
  const { gate, full } = await fixture(t)
  const domains = ['dsh', 'opencode', 'real-engines']
  const baseline = { sha, run: 1, completedAt: new Date(Date.now() - 49 * 3600_000).toISOString() }
  const incremental = { ...full, domains: JSON.stringify(domains) }
  incremental.macProof = fixtureMacProof(incremental)
  assert.throws(() => checkGate({ ...gate, domains, baseline }, incremental, context), /基线过期/)
})

test('APK 要核对 package、versionCode、versionName、ABI 和非 debug manifest', () => {
  const good =
    "package: name='dev.litch' versionCode='1002003' versionName='1.2.3'\nnative-code: 'arm64-v8a'\n"
  checkApkManifest(good, '1.2.3', 'dev.litch')
  for (const bad of [
    good.replace('1002003', '1002002'),
    good.replace('1.2.3', '1.2.2'),
    good.replace('dev.litch', 'dev.other'),
    good.replace('arm64-v8a', 'x86_64'),
    `${good}application-debuggable\n`,
  ])
    assert.throws(() => checkApkManifest(bad, '1.2.3', 'dev.litch'))
})

test('公开必须显式确认；旧版本/已公开/外来草稿/资产缺失拒绝', () => {
  promotionInputs(env)
  assert.throws(() => promotionInputs({ ...env, PROMOTE_MODE: 'publish' }), /公开须/)
  promotionInputs({ ...env, PROMOTE_MODE: 'publish', CONFIRM_PUBLICATION: env.TAG })
  assert.throws(() => checkVersion('v1.2.3', 'v1.2.4'), /不准晋级/)
  const draft = { tag_name: env.TAG, draft: true, prerelease: false, body: 'marker' }
  checkDraft(draft, env.TAG, 'marker')
  for (const patch of [{ draft: false }, { body: 'unrelated' }, { tag_name: 'v1.2.2' }])
    assert.throws(() => checkDraft({ ...draft, ...patch }, env.TAG, 'marker'))
  assert.throws(() => checkAssets([], { 'app.zip': { size: 1 } }), /资产缺失/)
})

async function serviceFixture(t) {
  const f = await fixture(t)
  const commands = []
  let release
  let tagExists = false
  let policyCalls = 0
  const assets = []
  const bytes = new Map()
  const jobs = Object.entries(f.artifacts).map(([kind, a]) => ({
    id: a.jobId,
    name:
      kind === 'gate-proof'
        ? 'gate / result'
        : kind === 'full-proof'
          ? 'gate / tests / report'
          : kind,
    status: 'completed',
    conclusion: 'success',
    run_attempt: a.attempt,
    steps:
      kind === 'desktop-macos'
        ? [acceptedStep, uploadStep].map((name) => ({ name, conclusion: 'success' }))
        : [],
  }))
  jobs.push({ id: 200, name: 'seal', status: 'completed', conclusion: 'success', run_attempt: 3 })
  const services = {
    policyHash: () => policy,
    api(path, fields) {
      if (path.endsWith('/actions/runs/42')) return run
      if (path.endsWith('/actions/artifacts/99')) return artifact
      if (path.endsWith('/actions/artifacts/88')) return { ...artifact, ...checkpoint.artifact }
      const source = Object.values(f.artifacts).find((a) =>
        path.endsWith(`/actions/artifacts/${a.id}`),
      )
      if (source) return { ...artifact, ...source }
      if (path.includes('matching-refs')) return tagExists ? [{ ref: `refs/tags/${env.TAG}` }] : []
      if (fields) {
        commands.push({ path, fields })
        if (path.endsWith('/git/refs')) {
          tagExists = true
          return {}
        }
        if (path.endsWith('/generate-notes')) return { body: 'fixture notes' }
        if (path.endsWith('/releases')) {
          release = { ...fields, id: 7, html_url: 'https://example.test/draft' }
          return release
        }
      }
      if (path.endsWith('/releases/7')) return release
      throw new Error(`意外 API：${path}`)
    },
    pages(path) {
      if (path.includes('/jobs?')) {
        const match = /\/attempts\/(\d+)\//.exec(path)
        return match ? jobs.filter((job) => job.run_attempt === Number(match[1])) : jobs
      }
      if (path.includes('/assets?')) return assets
      if (path.endsWith('/releases?per_page=100')) return release ? [release] : []
      throw new Error(`意外分页：${path}`)
    },
    downloadArtifact: async (_repo, _artifact, dir) => cpSync(f.dir, dir, { recursive: true }),
    async download(url, path) {
      const match = /\/assets\/(\d+)$/.exec(url)
      writeFileSync(path, match ? bytes.get(Number(match[1])) : 'fixture source tar')
    },
    gh(args, options) {
      commands.push({ args })
      if (args[0] === 'api') {
        assert.equal(args[3], 'PATCH')
        Object.assign(release, JSON.parse(options.input))
        return JSON.stringify(release)
      }
      assert.deepEqual(args.slice(0, 5), [
        'release',
        'upload',
        env.TAG,
        '--repo',
        env.GITHUB_REPOSITORY,
      ])
      for (const path of args.slice(5)) {
        const contents = readFileSync(path)
        const id = 500 + assets.length
        assets.push({ id, name: basename(path), size: contents.length, state: 'uploaded' })
        bytes.set(id, contents)
      }
      return ''
    },
    async releasePolicy() {
      policyCalls++
      checkVersion(env.TAG, 'v1.2.2')
    },
  }
  return {
    ...f,
    services,
    commands,
    jobs,
    assets,
    bytes,
    state: () => ({ release, tagExists, policyCalls }),
    output: temp(t),
  }
}

test('晋级端到端替身演练：verify 零写入；draft 回验同一 bytes，重复提交不重传且从不构建', async (t) => {
  const f = await serviceFixture(t)
  const verify = await promote({ ...env, PROMOTE_OUTPUT: f.output }, f.services)
  assert.equal(verify.mode, 'verify')
  assert.deepEqual(f.commands, [])
  assert.equal(f.state().tagExists, false)
  const input = { ...env, PROMOTE_MODE: 'draft', PROMOTE_OUTPUT: f.output }
  await promote(input, f.services)
  assert.equal(f.state().release.draft, true)
  assert.equal(f.state().release.make_latest, 'false')
  assert.equal(f.commands.filter((c) => c.args?.[0] === 'release').length, 1)
  await promote(input, f.services)
  assert.equal(f.commands.filter((c) => c.args?.[0] === 'release').length, 1)
  assert.equal(f.state().release.draft, true)
  assert.ok(f.state().policyCalls >= 7)
  const tap = JSON.parse(readFileSync(join(f.output, 'tap-inputs.json'), 'utf8'))
  assert.equal(tap.sha, sha)
  assert.equal(tap.artifactId, 99)
  assert.match(tap.url, /v1\.2\.3\.tar\.gz$/)
  // 受控服务没有提供打包/签名命令；意外调用会让上面的 gh 断言失败。
  assert.equal(
    f.commands.some((c) => c.args?.includes('PATCH')),
    false,
  )
})

test('产品与基础设施混合失败不得晋级，旧成功 artifact 不能代替失败 job', async (t) => {
  const f = await serviceFixture(t)
  f.jobs.find((job) => job.name === 'gate / result').conclusion = 'failure'
  await assert.rejects(promote({ ...env, PROMOTE_OUTPUT: f.output }, f.services), /未通过/)
  assert.deepEqual(f.commands, [])
})

test('下载回验损坏不公开；标签移动或新 blocker 在最后检查时仍阻断', async (t) => {
  const f = await serviceFixture(t)
  const bad = { ...f.services, download: async (_url, path) => writeFileSync(path, 'corrupt') }
  const input = {
    ...env,
    PROMOTE_MODE: 'publish',
    CONFIRM_PUBLICATION: env.TAG,
    PROMOTE_OUTPUT: f.output,
  }
  await assert.rejects(promote(input, bad), /下载回验失败/)
  assert.equal(f.state().release.draft, true)
  assert.equal(
    f.commands.some((c) => c.args?.includes('PATCH')),
    false,
  )
  let calls = 0
  const moved = {
    ...f.services,
    releasePolicy: async () => {
      if (++calls === 3) throw Error('标签已移动或出现新 release-blocker')
    },
  }
  await assert.rejects(promote(input, moved), /标签已移动/)
  assert.equal(f.state().release.draft, true)
})

test('全部回验通过且明确授权后只 PATCH 一次公开；重复公开请求拒绝', async (t) => {
  const f = await serviceFixture(t)
  const input = {
    ...env,
    PROMOTE_MODE: 'publish',
    CONFIRM_PUBLICATION: env.TAG,
    PROMOTE_OUTPUT: f.output,
  }
  await promote(input, f.services)
  assert.equal(f.state().release.draft, false)
  assert.equal(f.state().release.make_latest, 'true')
  await assert.rejects(promote(input, f.services), /禁止覆盖已公开/)
  assert.equal(f.commands.filter((c) => c.args?.includes('PATCH')).length, 1)
})

test('重复 Prepare 复用现有候选提示；原 run 的失败重跑和过期候选不误拦', () => {
  const old = { ...run, created_at: new Date().toISOString() }
  const options = { sha, currentRun: '43' }
  assert.equal(existingCandidate([old], () => [artifact], options).run, 42)
  assert.equal(
    existingCandidate([old], () => [artifact], { ...options, currentRun: '42' }),
    undefined,
  )
  assert.equal(
    existingCandidate([{ ...old, conclusion: 'failure' }], () => [artifact], options),
    undefined,
  )
  assert.equal(
    existingCandidate([old], () => [{ ...artifact, expired: true }], options),
    undefined,
  )
})

test('夜间手机修复项只接受真实 schedule 的完整证明，不把部分 Full 当手机故障', async (t) => {
  const { full } = await fixture(t)
  const nightly = {
    ...run,
    path: '.github/workflows/full.yml',
    event: 'schedule',
    conclusion: 'failure',
  }
  const proof = {
    ...full,
    domains: '',
    event: 'schedule',
    jobs: { ...full.jobs, mobile: 'failure' },
  }
  assert.deepEqual(mobileFailure(nightly, proof, context.repository), ['mobile'])
  assert.throws(() => mobileFailure(nightly, { ...proof, attempt: 1 }, context.repository))
  assert.throws(() =>
    mobileFailure(nightly, { ...proof, domains: '["mobile"]' }, context.repository),
  )
  assert.throws(() =>
    mobileFailure({ ...nightly, event: 'workflow_dispatch' }, proof, context.repository),
  )
})

test('晋级工作流没有构建/测试调用，标签不会启动第二轮 Prepare', () => {
  const prepare = readFileSync(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  )
  const promotion = readFileSync(
    new URL('../../.github/workflows/promote.yml', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(prepare, /^ {2}push:/m)
  assert.doesNotMatch(promotion, /uses: \.\/\.github\/workflows\/(gate|full|release)\.yml/)
  assert.doesNotMatch(promotion, /run:.*(?:npm|make-installer|notarytool|stapler|codesign)/)
  assert.match(prepare, /make-installer\.mjs --require-signing/)
  assert.doesNotMatch(prepare, /临时签名的 dmg|用调试钥匙签/)
})
