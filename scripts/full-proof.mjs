// Full 的输入和实际检出共同构成证明；工作流显示 success 不能替代完整覆盖。
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { hasLinuxCoverage } from './ci/linux-proof.mjs'
import { checkNativeProof, selectedNative } from './ci/mac-native-plan.mjs'
import { domains, releaseDomains } from './ci-impact.mjs'

export function hasMacCoverage(full) {
  try {
    const selected = selectedNative(full.domains, full.runCi)
    if (!selected.length) return full.macProof === null
    const { artifact, proof } = full.macProof
    if (
      full.jobs?.native !== 'success' ||
      !Number.isSafeInteger(artifact.id) ||
      artifact.id <= 0 ||
      !Number.isSafeInteger(artifact.jobId) ||
      artifact.jobId <= 0 ||
      !Number.isSafeInteger(artifact.attempt) ||
      artifact.attempt < 1 ||
      artifact.attempt > full.attempt ||
      artifact.name !== `mac-native-proof-${artifact.attempt}` ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)
    )
      return false
    checkNativeProof(proof, selected, {
      repository: full.repository,
      sha: full.sha,
      workflowSha: full.workflowSha,
      runId: full.runId,
      attempt: artifact.attempt,
    })
    return true
  } catch {
    return false
  }
}

export const fullJobs = [
  'source',
  'gate',
  'native',
  'adapters',
  'computer-use',
  'computer-use-windows',
  'client',
  'dsh',
  'opencode',
  'client-engines',
  'real-engines',
  'mobile-build',
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
      hasMacCoverage(proof) &&
      hasLinuxCoverage(proof) &&
      fullJobs.every((job) => proof.jobs?.[job] === 'success'),
  )
}

// 完整 Full 含手机静态检查与 APK；模拟器仅手动按需执行，不在这份证明的必跑集合内。
export function hasReleaseCoverage(proof) {
  if (typeof proof?.domains !== 'string') return false
  let selected
  try {
    selected = proof?.domains?.trim() ? JSON.parse(proof.domains) : domains
  } catch {
    return false
  }
  return Boolean(
    proof?.schema === 1 &&
      hasMacCoverage(proof) &&
      hasLinuxCoverage(proof) &&
      proof.runCi === true &&
      Array.isArray(selected) &&
      new Set(selected).size === selected.length &&
      selected.every((domain) => domains.includes(domain)) &&
      releaseDomains.every((domain) => selected.includes(domain)) &&
      fullJobs
        .filter((job) => !['mobile', 'mobile-build'].includes(job))
        .every((job) => proof.jobs?.[job] === 'success'),
  )
}

export function isCompleteReleaseFull(
  run,
  proof,
  sha,
  repository,
  { runningCandidate = false, verifiedPreviousAttempt = false } = {},
) {
  const standalone = run?.path === '.github/workflows/full.yml'
  const candidate = ['.github/workflows/release.yml', '.github/workflows/gate.yml'].includes(
    run?.path,
  )
  const mobileFailed = ['mobile', 'mobile-build'].some((job) =>
    ['failure', 'cancelled', 'timed_out'].includes(proof?.jobs?.[job]),
  )
  return Boolean(
    (standalone || candidate) &&
      Number.isSafeInteger(run.id) &&
      Number.isSafeInteger(run.run_attempt) &&
      ((run.status === 'completed' &&
        (run.conclusion === 'success' || (run.conclusion === 'failure' && mobileFailed))) ||
        (runningCandidate && candidate && run.status === 'in_progress')) &&
      ['workflow_dispatch', 'schedule'].includes(run.event) &&
      proof?.repository === repository &&
      proof.runId === run.id &&
      (proof.attempt === run.run_attempt ||
        (verifiedPreviousAttempt &&
          candidate &&
          Number.isSafeInteger(proof.attempt) &&
          proof.attempt >= 1 &&
          proof.attempt < run.run_attempt)) &&
      proof.event === run.event &&
      proof.workflowSha === run.head_sha &&
      proof.sha === sha &&
      /^[a-f0-9]{40}$/.test(sha) &&
      hasReleaseCoverage(proof),
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
  const bound = JSON.parse(readFileSync('check-proofs-bound.json', 'utf8'))
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
    // report 不等待可选三片，不在此伪造其最终结果；需要查 mobile job/逐 flow 制品。
    mobileE2e: { requested: env.FULL_MOBILE_E2E === 'true', required: false },
    jobs: Object.fromEntries(Object.entries(needs).map(([job, data]) => [job, data.result])),
    macProof: bound.macProof,
    linuxProofs: bound.linuxProofs,
  }
  if (!hasMacCoverage(proof)) throw new Error('合并Mac的检查证明缺失、失败或来源不符')
  if (!hasLinuxCoverage(proof)) throw new Error('复用Linux的检查证明缺失、失败或来源不符')
  const selected = selectedNative(proof.domains, proof.runCi)
  for (const domain of ['computer-use', 'client', 'client-engines']) {
    proof.jobs[domain] = selected.includes(domain) ? 'success' : 'skipped'
  }
  if (selected.includes('client')) {
    const units = proof.runCi ? needs.gate?.result : needs['client-unit']?.result
    if (units !== 'success') proof.jobs.client = 'failure'
  }
  proof.releaseCoverage = {
    mobileE2eRequired: false,
    reason: '用户决定：模拟器 E2E 不参与发版',
    passed: hasReleaseCoverage(proof),
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
