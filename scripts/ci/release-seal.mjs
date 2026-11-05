import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { checkCheckpointJob } from '../../apps/desktop/scripts/macos-checkpoint.mjs'
import { releasePolicy } from '../release-policy.mjs'
import { artifactKinds } from '../release-provenance.mjs'
import { bypassReason, gateBypass } from './gate-bypass.mjs'
import { api, downloadArtifact, pages, validateArtifact } from './release-artifacts.mjs'
import {
  checkJob,
  checkNotarization,
  chooseArtifact,
  inventory,
  policyHash,
  readJson,
  sealCandidate,
  sourceRun,
  summary,
  writeJson,
} from './release-candidate.mjs'

const dir = process.argv[2]
mkdirSync(dir, { recursive: true })
const context = {
  repository: process.env.GITHUB_REPOSITORY,
  sha: process.env.CANDIDATE_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  version: readJson('package.json').version,
}
const base = `repos/${context.repository}/actions/runs/${context.runId}`
sourceRun(api(base), context, { preparing: true })
const listed = pages(`${base}/artifacts?per_page=100`, 'artifacts')
const latestJobs = pages(`${base}/jobs?filter=latest&per_page=100`, 'jobs')
const artifacts = {}
const bypassed = bypassReason() !== null
for (const kind of bypassed ? artifactKinds : [...artifactKinds, 'gate-proof', 'full-proof']) {
  const selected = chooseArtifact(listed, kind, context)
  const name =
    kind === 'gate-proof' ? 'gate / result' : kind === 'full-proof' ? 'gate / tests / report' : kind
  const jobs = pages(`${base}/attempts/${selected.attempt}/jobs?per_page=100`, 'jobs')
  selected.jobId = checkJob(jobs, name, selected.attempt)
  if (!latestJobs.some((job) => job.name === name && job.conclusion === 'success'))
    throw new Error(`最新 ${name} 未通过，禁止用旧成功覆盖`)
  artifacts[kind] = selected
  const artifact = validateArtifact(
    listed.find((item) => item.id === selected.id),
    { run: context.runId, sha: context.sha, name: selected.name, digest: selected.digest },
  )
  await downloadArtifact(context.repository, artifact, dir)
}
if (bypassed) writeJson(join(dir, 'gate-proof.json'), gateBypass(context))
const manifest = await sealCandidate(dir, context, artifacts, policyHash())
const notarization = checkNotarization(
  readJson(join(dir, 'release-provenance-desktop-macos.json')),
  context,
)
validateArtifact(
  listed.find((item) => item.id === notarization.artifact.id),
  {
    run: context.runId,
    sha: context.sha,
    name: notarization.artifact.name,
    digest: notarization.artifact.digest,
  },
)
checkCheckpointJob(
  pages(`${base}/attempts/${notarization.attempt}/jobs?per_page=100`, 'jobs'),
  notarization.attempt,
)
manifest.history = []
for (let attempt = 1; attempt <= context.attempt; attempt++) {
  const jobs = pages(`${base}/attempts/${attempt}/jobs?per_page=100`, 'jobs')
  manifest.history.push({
    attempt,
    failures: jobs
      .filter((job) => ['failure', 'cancelled', 'timed_out'].includes(job.conclusion))
      .map((job) => ({
        id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        url: `https://github.com/${context.repository}/actions/runs/${context.runId}/job/${job.id}`,
      })),
  })
}
const source = api(base)
await releasePolicy({
  candidateFull: { run: source, proof: manifest.full, verifiedPreviousAttempt: true },
  gate: manifest.gate,
  branch: source.head_branch,
  version: context.version,
})
// 最终清单也纳入封存 hash；晋级阶段绝不重新生成它们。
execFileSync('sha256sum', ['-c', 'codex-harness-adapter-SHA256SUMS.txt'], {
  cwd: dir,
  stdio: 'inherit',
})
execFileSync('sha256sum', ['-c', 'cha-SHA256SUMS.txt'], { cwd: dir, stdio: 'inherit' })
const raw = await inventory(dir)
const { writeFileSync } = await import('node:fs')
writeFileSync(
  join(dir, 'Litch-SHA256SUMS.txt'),
  Object.entries(raw)
    .filter(([name]) => /^Litch-.*\.(dmg|zip|exe|apk)$/.test(name))
    .map(([name, file]) => `${file.sha256}  ${name}\n`)
    .join(''),
)
execFileSync(
  process.execPath,
  [
    'scripts/update-manifest.mjs',
    '--dir',
    dir,
    '--tag',
    `v${context.version}`,
    '--repo',
    context.repository,
  ],
  { stdio: 'inherit' },
)
manifest.files = await inventory(dir)
writeJson(join(dir, 'candidate.json'), manifest)
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(manifest))
