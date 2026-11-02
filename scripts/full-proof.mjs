// Full 的输入和实际检出共同构成证明；工作流显示 success 不能替代完整覆盖。
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { domains } from './ci-impact.mjs'

export const fullJobs = [
  'source',
  'gate',
  'adapters',
  'computer-use',
  'computer-use-windows',
  'client',
  'dsh',
  'opencode',
  'client-engines',
  'real-engines',
  'mobile-build',
  'mobile',
]

export function hasAllDomains(value) {
  if (typeof value !== 'string') return false
  if (!value.trim()) return true
  try {
    const parsed = JSON.parse(value)
    return (
      Array.isArray(parsed) &&
      parsed.length === domains.length &&
      new Set(parsed).size === domains.length &&
      domains.every((domain) => parsed.includes(domain))
    )
  } catch {
    return false
  }
}

export function isCompleteFull(run, proof, sha, repository) {
  return Boolean(
    run?.path === '.github/workflows/full.yml' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      ['workflow_dispatch', 'schedule'].includes(run.event) &&
      proof?.schema === 1 &&
      proof.repository === repository &&
      Number.isSafeInteger(run.id) &&
      proof.runId === run.id &&
      Number.isSafeInteger(run.run_attempt) &&
      proof.attempt === run.run_attempt &&
      proof.event === run.event &&
      proof.workflowSha === run.head_sha &&
      /^[a-f0-9]{40}$/.test(sha) &&
      proof.sha === sha &&
      proof.runCi === true &&
      hasAllDomains(proof.domains) &&
      fullJobs.every((job) => proof.jobs?.[job] === 'success'),
  )
}

export async function findSuccessfulFull(runs, sha, repository, loadProof) {
  for (const run of runs) {
    if (
      run.path !== '.github/workflows/full.yml' ||
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      !['workflow_dispatch', 'schedule'].includes(run.event)
    )
      continue
    let proof
    try {
      proof = await loadProof(run)
    } catch {
      continue
    }
    if (isCompleteFull(run, proof, sha, repository)) return run
  }
  return undefined
}

export function writeFullProof(env = process.env) {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/.test(env.FULL_SOURCE_SHA ?? '') || sha !== env.FULL_SOURCE_SHA) {
    throw new Error('汇总 job 的实际检出与 Full 冻结 SHA 不同')
  }
  const needs = JSON.parse(env.FULL_NEEDS)
  const proof = {
    schema: 1,
    repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    event: env.GITHUB_EVENT_NAME,
    workflowSha: env.GITHUB_SHA,
    sha,
    requestedSha: env.FULL_REQUESTED_SHA,
    domains: env.FULL_DOMAINS,
    runCi: env.FULL_RUN_CI === 'true',
    mobileDisableVulkan: env.FULL_MOBILE_DISABLE_VULKAN === 'true',
    jobs: Object.fromEntries(Object.entries(needs).map(([job, data]) => [job, data.result])),
  }
  writeFileSync('full-proof.json', `${JSON.stringify(proof, null, 2)}\n`)
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `\n## Full 实际检查范围\n\n\`\`\`json\n${JSON.stringify(proof, null, 2)}\n\`\`\`\n`,
    )
  }
  return proof
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFullProof()
