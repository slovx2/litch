// 纯只读判定；eligible 只表示首败可恢复，绝不是调用重跑 API 的授权。
import { createHash } from 'node:crypto'

export const recoveryVersion = 'infra-recovery-v1'
export const recoveryWindowMs = 2 * 60 * 60_000
export const workflowPaths = ['ci', 'full', 'gate', 'release', 'windows'].map(
  (name) => `.github/workflows/${name}.yml`,
)
const preparation = new Map([
  ['Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'checkout'],
  ['Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', 'node'],
  ['Run actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e', 'go'],
])
const passive = new Set([
  'Set up job',
  'Run actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830',
])
const terminal = new Set(['success', 'skipped', 'failure', 'cancelled', 'timed_out'])
export const evidenceHash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex')

function verdict(kind, reason, extra = {}) {
  return { kind, reason, ...extra }
}

export function classifyJob(job, evidence = {}) {
  if (job.status !== 'completed') return verdict('unknown', 'job-not-completed')
  if (job.conclusion === 'success') return verdict('passed', 'success')
  if (job.conclusion === 'skipped') return verdict('skipped', 'dependency-or-condition')
  // 手机和已有窄重试不叠加整片预算；未知的新job默认仍需下面的证据。
  if (/(^| \/ )mobile(?: \(|-|$)/.test(job.name))
    return verdict('excluded', 'mobile-existing-budget')
  const steps = job.steps ?? []
  const annotations = evidence.annotations ?? []
  if (!job.runner_name && job.runner_id === 0 && steps.length === 0) {
    const failures = annotations.filter((item) => item.annotation_level === 'failure')
    const capacity =
      failures.length > 0 &&
      failures.every(
        (item) =>
          item.message ===
          'The job was not acquired by Runner of type hosted even after multiple attempts',
      )
    if (capacity && ['cancelled', 'failure'].includes(job.conclusion))
      return verdict('infra', 'hosted-runner-not-acquired', {
        evidenceHash: evidenceHash(annotations),
      })
    return verdict('unknown', 'no-runner-without-platform-failure')
  }
  if (job.conclusion !== 'failure') return verdict('unknown', 'cancelled-or-timeout')
  if (!job.runner_name || !job.runner_id) return verdict('unknown', 'runner-identity-missing')
  if (!steps.length || new Set(steps.map((step) => step.number)).size !== steps.length)
    return verdict('unknown', 'steps-missing-or-duplicate')
  const ordered = [...steps].sort((a, b) => a.number - b.number)
  const failed = ordered.filter((step) => !['success', 'skipped'].includes(step.conclusion))
  if (failed.length !== 1 || failed[0].conclusion !== 'failure')
    return verdict('unknown', 'multiple-or-unknown-step-failures')
  const step = failed[0]
  if (!preparation.has(step.name))
    return verdict('product-or-unknown', 'not-allowlisted-preparation')
  // 准备动作若在测试/签名之后执行，即使明确网络错误也不恢复整片。
  if (
    ordered.some(
      (item) =>
        item.number < step.number &&
        item.conclusion !== 'skipped' &&
        !preparation.has(item.name) &&
        !passive.has(item.name),
    ) ||
    ordered.some(
      (item) =>
        item.number > step.number &&
        item.conclusion !== 'skipped' &&
        !item.name.startsWith('Post ') &&
        item.name !== '缓存与首次失败' &&
        item.name !== 'Complete job',
    )
  )
    return verdict('unknown', 'other-command-executed')
  const log = evidence.stepLog
  if (!log || log.number !== step.number || log.complete !== true || typeof log.text !== 'string')
    return verdict('unknown', 'exact-step-log-missing')
  // 只返回固定原因和hash，不把可能含凭据的原始输出写进审计。
  if (
    /permission denied|access denied|no space left|checksum|integrity|certificate|unauthorized|forbidden|\b(401|403|404|429)\b|retry.*exhaust|attempts? exhausted/i.test(
      log.text,
    )
  )
    return verdict('unknown', 'non-transient-or-exhausted')
  // 前面的网络重试可能已恢复；必须是最后一条明确错误，而不是挑任意网络词。
  const lastError = log.text
    .split('\n')
    .filter((line) => /##\[error\]|\bError:|\bfatal:/.test(line))
    .at(-1)
  const network =
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|Connection reset by peer|Failed to connect to [^\n]+ port 443|The requested URL returned error: (?:500|502|503|504)\b|HTTP(?:\/\d(?:\.\d)?)? (?:500|502|503|504)\b/.test(
      lastError ?? '',
    )
  if (!network) return verdict('unknown', 'no-explicit-network-failure')
  return verdict('infra', `preparation-${preparation.get(step.name)}-network`, {
    step: step.number,
    evidenceHash: evidenceHash(log.text),
  })
}

export function planRecovery(
  snapshot,
  { now = Date.now(), reserved = false, classify = classifyJob, paths = workflowPaths } = {},
) {
  const { run, jobs, evidence = {}, sourceBinding, activeMac = [] } = snapshot
  const context = {
    rule: recoveryVersion,
    repository: run.repository?.full_name,
    runId: run.id,
    sha: run.head_sha,
    attempt: run.run_attempt,
    workflow: run.path,
    createdAt: run.created_at,
  }
  const report = {
    ...context,
    mode: 'observe',
    automatic: false,
    sourceBinding,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      ...classify(job, evidence[job.id]),
    })),
  }
  const stop = (reason, decision = 'blocked') => ({ ...report, decision, reason, roots: [] })
  if (
    context.repository !== 'slovx2/litch' ||
    run.head_repository?.full_name !== context.repository ||
    !paths.includes(run.path) ||
    !['push', 'schedule', 'workflow_dispatch'].includes(run.event) ||
    !Number.isSafeInteger(run.id) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '')
  )
    return stop('untrusted-source')
  if (
    sourceBinding?.matched !== true ||
    sourceBinding.sha !== run.head_sha ||
    !/^[a-f0-9]{40}$/.test(sourceBinding.trustedSha ?? '') ||
    !/^[a-f0-9]{64}$/.test(sourceBinding.digest ?? '')
  )
    return stop('workflow-contract-not-bound')
  if (run.run_attempt !== 1 || reserved) return stop('recovery-budget-unavailable')
  if (run.status !== 'completed' || jobs.some((job) => job.status !== 'completed'))
    return stop('source-run-not-completed')
  if (run.conclusion === 'success') return stop('nothing-to-recover', 'none')
  // 人工/并发组取消的整轮绝不由“某片容量注解”覆盖。
  if (run.conclusion !== 'failure') return stop('run-not-failure')
  if (
    jobs.length === 0 ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    new Set(jobs.map((job) => job.name)).size !== jobs.length ||
    jobs.some(
      (job) =>
        !Number.isSafeInteger(job.id) ||
        job.id <= 0 ||
        job.run_id !== run.id ||
        job.run_attempt !== 1 ||
        job.head_sha !== run.head_sha ||
        !terminal.has(job.conclusion),
    )
  )
    return stop('job-source-or-identity-mismatch')
  const bad = report.jobs.filter((job) => !['passed', 'skipped', 'dependent'].includes(job.kind))
  if (bad.length === 0) return stop('failure-without-classifiable-root')
  if (bad.some((job) => job.kind !== 'infra')) return stop('product-unknown-or-mixed-failure')
  const ended = Date.parse(run.updated_at)
  if (!Number.isFinite(ended) || !Number.isFinite(now) || now < ended)
    return stop('invalid-completion-clock')
  if (now - ended >= recoveryWindowMs) return stop('recovery-window-expired')
  const mac = jobs.some(
    (job) =>
      job.conclusion !== 'success' &&
      (job.labels ?? []).some((label) => /^macos(?:-|$)/.test(label)),
  )
  if (mac && activeMac.length > 0) return stop('other-mac-run-active', 'deferred')
  return {
    ...report,
    decision: 'eligible',
    reason: 'only-evidenced-infrastructure-roots',
    roots: bad.map(({ id, name, reason }) => ({ id, name, reason })),
    // 只读第一阶段不推断DAG。写控制器必须另行绑定必要下游后才可reservation。
    dependencyClosureVerified: false,
    expiresAt: new Date(ended + recoveryWindowMs).toISOString(),
  }
}
