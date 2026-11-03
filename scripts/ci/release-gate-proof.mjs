import { appendFileSync, readFileSync } from 'node:fs'
import { readFullProofArtifact } from '../full-proof-artifact.mjs'
import { releasePolicy } from '../release-policy.mjs'
import { api, pages } from './release-artifacts.mjs'
import {
  checkGate,
  checkJob,
  chooseArtifact,
  policyVersion,
  writeJson,
} from './release-candidate.mjs'

const context = {
  repository: process.env.GITHUB_REPOSITORY,
  sha: process.env.CANDIDATE_SHA,
  runId: process.env.GITHUB_RUN_ID,
  attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
}
const path = `repos/${context.repository}/actions/runs/${context.runId}`
const run = api(path)
const fullArtifact = chooseArtifact(
  pages(`${path}/artifacts?per_page=100`, 'artifacts'),
  'full-proof',
  context,
)
fullArtifact.jobId = checkJob(
  pages(`${path}/attempts/${fullArtifact.attempt}/jobs?per_page=100`, 'jobs'),
  run.path === '.github/workflows/release.yml' ? 'gate / tests / report' : 'tests / report',
  fullArtifact.attempt,
)
const full = await readFullProofArtifact(
  context.repository,
  { ...run, run_attempt: fullArtifact.attempt },
  api,
)
const gate = {
  schema: 2,
  mode: process.env.RELEASE_MODE || 'standard',
  repository: context.repository,
  policy: policyVersion,
  mobileStatic: 'success',
  createdAt: new Date().toISOString(),
  sha: context.sha,
  run: context.runId,
  attempt: String(context.attempt),
  domains: JSON.parse(process.env.DOMAINS),
  baseline: JSON.parse(process.env.BASELINE),
  fullArtifact,
  conclusion: 'success',
}
checkGate(gate, full, context)
await releasePolicy({
  candidateFull: { run, proof: full, verifiedPreviousAttempt: true },
  gate,
  branch: run.head_branch,
  version: JSON.parse(readFileSync('package.json', 'utf8')).version,
})
writeJson('gate-proof.json', gate)
appendFileSync(process.env.GITHUB_OUTPUT, `sha=${context.sha}\n`)
