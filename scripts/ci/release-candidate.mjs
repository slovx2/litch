// 候选只封存一次；晋级检查数据，不执行候选包里的代码。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkCheckpoint } from '../../apps/desktop/scripts/macos-checkpoint.mjs'
import { mandatory, releaseDomains } from '../ci-impact.mjs'
import { hasMacCoverage, hasReleaseCoverage } from '../full-proof.mjs'
import { artifactKinds } from '../release-provenance.mjs'
import { hasLinuxCoverage } from './linux-proof.mjs'
import { fileHash, validateArtifact } from './release-artifacts.mjs'
import { hasWindowsCoverage } from './windows-proof.mjs'

export const policyVersion = 'candidate-v4-mac-consolidated'
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
export const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

export function requiredPackages(version) {
  return {
    adapter: ['linux-x64', 'linux-arm64', 'darwin-arm64']
      .map((target) => `codex-harness-adapter-${version}-${target}.tar.gz`)
      .concat(['codex-harness-adapter-SHA256SUMS.txt', 'install.sh']),
    cha: [`cha-v${version}.tar.gz`, 'cha-SHA256SUMS.txt'],
    'desktop-macos': [`Litch-${version}-macos-arm64.dmg`, `Litch-${version}-macos-arm64.zip`],
    'desktop-windows': [`Litch-${version}-windows-x64-setup.exe`],
    android: [`Litch-${version}-android-arm64.apk`],
  }
}

export function policyHash() {
  const names = execFileSync(
    'git',
    [
      'ls-files',
      '.github/workflows',
      'scripts/ci',
      'scripts/ci-*.mjs',
      'scripts/release-*.mjs',
      'scripts/full-proof*.mjs',
      'scripts/update-manifest.mjs',
      'protocol/versions.json',
      'apps/desktop/scripts/macos-checkpoint.mjs',
      'apps/desktop/scripts/notarize.mjs',
      'apps/desktop/scripts/make-installer.mjs',
      'apps/desktop/scripts/verify-macos-distribution.mjs',
      'apps/desktop/scripts/nightly-checks.mjs',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
  // 包含新增尚未提交文件，开发测试与提交后相同；忽略测试文件。
  for (const name of readdirSync('scripts/ci')) names.push(`scripts/ci/${name}`)
  const hash = createHash('sha256')
  for (const name of [...new Set(names)].filter((name) => !name.endsWith('.test.mjs')).sort())
    hash.update(`${name}\0`).update(readFileSync(name)).update('\0')
  return hash.digest('hex')
}

export function sourceRun(run, { repository, sha, runId, attempt }, { preparing = false } = {}) {
  assert.equal(run.repository?.full_name, repository, 'source repository')
  assert.equal(run.path, '.github/workflows/release.yml', 'source workflow')
  assert.equal(run.event, 'workflow_dispatch', 'source event')
  assert.equal(run.head_sha, sha, 'source SHA')
  assert.equal(run.id, Number(runId), 'source run')
  assert.equal(run.run_attempt, Number(attempt), 'source attempt 已变化')
  assert.equal(run.status, preparing ? 'in_progress' : 'completed', 'source status')
  if (!preparing) assert.equal(run.conclusion, 'success', 'source run 未通过')
}

export function chooseArtifact(artifacts, kind, context) {
  const found = artifacts
    .filter((artifact) => new RegExp(`^${kind}-[1-9][0-9]*$`).test(artifact.name))
    .sort((a, b) => Number(b.name.split('-').at(-1)) - Number(a.name.split('-').at(-1)))
  if (!found.length) throw new Error(`缺少 ${kind} artifact`)
  const artifact = found[0]
  const attempt = Number(artifact.name.split('-').at(-1))
  if (
    attempt > Number(context.attempt) ||
    found.some((a) => a.id !== artifact.id && a.name === artifact.name)
  )
    throw new Error('artifact attempt 错误或同名多义')
  validateArtifact(artifact, { run: context.runId, sha: context.sha, name: `${kind}-${attempt}` })
  return { id: artifact.id, name: artifact.name, digest: artifact.digest, attempt }
}

export function checkJob(jobs, name, attempt) {
  const found = jobs.filter((job) => job.name === name)
  if (
    found.length !== 1 ||
    found[0].conclusion !== 'success' ||
    found[0].status !== 'completed' ||
    found[0].run_attempt !== Number(attempt)
  )
    throw new Error(`来源 job 未通过或 attempt 不符：${name}`)
  return found[0].id
}

export async function inventory(dir, excluded = []) {
  const files = {}
  for (const name of readdirSync(dir).sort()) {
    if (excluded.includes(name)) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !statSync(join(dir, name)).isFile())
      throw new Error('候选只接受平铺普通文件')
    files[name] = { sha256: await fileHash(join(dir, name)), size: statSync(join(dir, name)).size }
  }
  return files
}

export function checkNotarization(proof, context) {
  const note = checkCheckpoint(proof.notarization, {
    repository: context.repository,
    sha: context.sha,
    run: String(context.runId),
    version: context.version,
    arch: 'arm64',
    attempt: Number(proof.attempt),
  })
  assert.equal(note.validatedAttempt, Number(proof.attempt), '票据验证 attempt')
  assert.equal(note.artifact.attempt, note.attempt, '公证来源 attempt')
  assert.equal(note.artifact.name, `macos-notarized-${note.attempt}`)
  assert.ok(Number.isSafeInteger(note.artifact.id) && note.artifact.id > 0)
  assert.match(note.artifact.digest, /^sha256:[a-f0-9]{64}$/)
  return note
}

export function checkGate(gate, full, context, now = Date.now()) {
  assert.equal(gate.schema, 2, 'gate schema')
  assert.equal(gate.repository, context.repository, 'gate repository')
  assert.equal(gate.sha, context.sha, 'gate SHA')
  assert.equal(gate.run, String(context.runId), 'gate run')
  assert.equal(gate.conclusion, 'success', 'gate conclusion')
  assert.equal(gate.policy, policyVersion, 'gate policy')
  assert.equal(gate.mobileStatic, 'success', '手机类型检查未通过')
  assert.ok(
    /^[1-9][0-9]*$/.test(gate.attempt) && Number(gate.attempt) <= Number(context.attempt),
    'gate attempt',
  )
  assert.ok(
    Array.isArray(gate.domains) &&
      new Set(gate.domains).size === gate.domains.length &&
      gate.domains.every((domain) => releaseDomains.includes(domain)) &&
      mandatory.every((domain) => gate.domains.includes(domain)),
    'gate domains',
  )
  assert.equal(full.repository, context.repository, 'full repository')
  assert.equal(full.schema, 1, 'full schema')
  assert.equal(full.event, 'workflow_dispatch', 'full event')
  assert.equal(full.runId, Number(context.runId), 'full run')
  assert.ok(
    Number.isSafeInteger(gate.fullArtifact?.attempt) &&
      gate.fullArtifact.attempt >= 1 &&
      gate.fullArtifact.attempt <= Number(gate.attempt),
    'full artifact attempt',
  )
  assert.equal(full.attempt, gate.fullArtifact.attempt, 'full attempt')
  assert.equal(full.workflowSha, context.sha, 'full workflow SHA')
  assert.equal(full.sha, context.sha, 'full checked SHA')
  assert.equal(full.runCi, true, 'full run-ci')
  assert.ok(hasMacCoverage(full), '合并Mac检查证明无效')
  assert.ok(hasLinuxCoverage(full), '复用Linux检查证明无效')
  assert.ok(hasWindowsCoverage(full), 'Windows原生检查证明无效')
  assert.deepEqual(JSON.parse(full.domains).sort(), [...gate.domains].sort(), 'full domains')
  for (const job of ['source', 'gate', ...gate.domains])
    assert.equal(full.jobs[job], 'success', `full job ${job}`)
  const created = Date.parse(gate.createdAt)
  assert.ok(Number.isFinite(created) && created <= now, 'gate 证明时间无效')
  if (!hasReleaseCoverage(full)) {
    const baseline = gate.baseline
    assert.ok(
      Number.isSafeInteger(baseline?.run) && /^[a-f0-9]{40}$/.test(baseline.sha),
      '缺少基线',
    )
    const age = now - Date.parse(baseline.completedAt)
    assert.ok(age >= 0 && age <= 48 * 3600_000, '夜间基线过期，须补验')
  }
}

export async function sealCandidate(dir, context, artifacts, policy, now = Date.now()) {
  const gate = readJson(join(dir, 'gate-proof.json'))
  const full = readJson(join(dir, 'full-proof.json'))
  checkGate(gate, full, context, now)
  // 验证原始平台清单，衍生文件在这之后才生成。
  const raw = readdirSync(dir).filter((name) => !['full-proof.json'].includes(name))
  // verifyProvenance 的严格文件白名单不接受 full-proof；由各份来源逐项核对。
  const proofs = artifactKinds.map((kind) => {
    const proof = readJson(join(dir, `release-provenance-${kind}.json`))
    assert.equal(proof.kind, kind)
    return proof
  })
  const covered = new Set([
    'gate-proof.json',
    ...artifactKinds.map((kind) => `release-provenance-${kind}.json`),
  ])
  for (const proof of proofs) {
    if (proof.kind === 'desktop-macos') checkNotarization(proof, context)
    assert.equal(proof.schema, 2)
    assert.equal(proof.sha, context.sha)
    assert.equal(proof.run, String(context.runId))
    assert.equal(proof.attempt, String(artifacts[proof.kind]?.attempt), 'pack attempt')
    assert.equal(
      proof.signing,
      ['desktop-macos', 'android'].includes(proof.kind) ? 'release' : 'not-required',
    )
    assert.ok(Object.keys(proof.files).length > 0)
    assert.deepEqual(
      Object.keys(proof.files).sort(),
      requiredPackages(context.version)[proof.kind].sort(),
      '平台产物清单不完整',
    )
    for (const [name, digest] of Object.entries(proof.files)) {
      assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
      assert.ok(!covered.has(name), '重复产物')
      assert.equal(await fileHash(join(dir, name)), digest, `hash ${name}`)
      covered.add(name)
    }
  }
  assert.deepEqual(raw.sort(), [...covered].sort(), '未登记文件')
  assert.equal(gate.attempt, String(artifacts['gate-proof'].attempt))
  assert.equal(full.attempt, artifacts['full-proof'].attempt)
  assert.deepEqual(gate.fullArtifact, artifacts['full-proof'], 'Gate 未绑定这份 Full artifact')
  const manifest = {
    schema: 2,
    policy: policyVersion,
    policyHash: policy,
    ...context,
    createdAt: new Date(now).toISOString(),
    artifacts,
    gate,
    full,
    files: {},
  }
  return manifest
}

export async function verifyCandidate(dir, context, policy, now = Date.now()) {
  const manifest = readJson(join(dir, 'candidate.json'))
  assert.equal(manifest.schema, 2, 'candidate schema')
  for (const key of ['repository', 'sha', 'runId', 'attempt', 'version'])
    assert.equal(String(manifest[key]), String(context[key]), `candidate ${key}`)
  assert.equal(manifest.policy, policyVersion, 'candidate policy')
  assert.equal(manifest.policyHash, policy, '验证策略已变，须补验')
  checkGate(manifest.gate, manifest.full, context, now)
  assert.deepEqual(
    await inventory(dir, ['candidate.json']),
    manifest.files,
    'candidate 文件/hash 不符',
  )
  assert.deepEqual(readJson(join(dir, 'gate-proof.json')), manifest.gate)
  assert.deepEqual(readJson(join(dir, 'full-proof.json')), manifest.full)
  assert.deepEqual(
    manifest.gate.fullArtifact,
    manifest.artifacts['full-proof'],
    'Full artifact 不符',
  )
  assert.equal(manifest.gate.attempt, String(manifest.artifacts['gate-proof'].attempt))
  for (const kind of [...artifactKinds, 'gate-proof', 'full-proof']) {
    const artifact = manifest.artifacts[kind]
    assert.ok(
      Number.isSafeInteger(artifact?.id) &&
        artifact.attempt >= 1 &&
        artifact.attempt <= Number(context.attempt),
    )
    assert.equal(artifact.name, `${kind}-${artifact.attempt}`)
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
  }
  for (const kind of artifactKinds) {
    const proof = readJson(join(dir, `release-provenance-${kind}.json`))
    if (kind === 'desktop-macos') checkNotarization(proof, context)
    assert.equal(proof.schema, 2)
    assert.equal(proof.kind, kind)
    assert.equal(proof.sha, context.sha)
    assert.equal(proof.run, String(context.runId))
    assert.equal(proof.attempt, String(manifest.artifacts[kind].attempt))
    assert.deepEqual(
      Object.keys(proof.files).sort(),
      requiredPackages(context.version)[kind].sort(),
      '平台产物清单不完整',
    )
    assert.equal(
      proof.signing,
      ['desktop-macos', 'android'].includes(kind) ? 'release' : 'not-required',
    )
    for (const [name, hash] of Object.entries(proof.files))
      assert.equal(manifest.files[name]?.sha256, hash)
  }
  return manifest
}

export function summary(manifest) {
  return (
    `## 候选 ${manifest.version}\n\nSHA：\`${manifest.sha}\`\n\n来源：[run ${manifest.runId}](https://github.com/${manifest.repository}/actions/runs/${manifest.runId}) / 验证 attempt ${manifest.attempt}\n\n` +
    `领域：${manifest.gate.domains.join(', ')}；手机模拟器 E2E 按用户决定不参与发版。\n\n` +
    `夜间基线：${manifest.gate.baseline?.url || '无，执行完整非手机领域'}\n\n` +
    `| 产物 | 来源 attempt | Artifact ID |\n|---|---|---|\n` +
    Object.entries(manifest.artifacts)
      .map(([kind, a]) => `| ${kind} | ${a.attempt} | ${a.id} |`)
      .join('\n') +
    '\n\n原始失败（重跑不会抹除）：\n' +
    ((manifest.history ?? [])
      .flatMap((attempt) =>
        attempt.failures.map(
          (job) => `- attempt ${attempt.attempt}：[${job.name}](${job.url}) — ${job.conclusion}`,
        ),
      )
      .join('\n') || '无') +
    '\n\nmacOS 签名、公证、票据、包启动及 ZIP 静态分发检查已执行；Android 已验正式签名和 manifest。Windows 仍按现行政策不签名。公开前仍需核对同 ZIP 的隔离 ShipIt 验收；断网首次启动未验。\n'
  )
}
