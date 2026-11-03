// 在只读分类之后绑定依赖闭包。只有这里核实后的计划能预占自动恢复预算。
import { buildRecoveryGraph, recoveryClosure } from './recovery-graph.mjs'
import { classifyJob, evidenceHash, planRecovery, workflowPaths } from './recovery-policy.mjs'

export const fixtureWorkflow = '.github/workflows/recovery-fixture.yml'
export const fixtureStep = '恢复演练：模拟准备下载'
const marker = '##[error]LITCH_RECOVERY_UPSTREAM_FAILURE'

function fixtureClassification(job, evidence, enabled) {
  if (!enabled) return classifyJob(job, evidence)
  // 仅对绑定了完整fixture源码的演练profile使用；正式路径没有这个例外。
  const copy = structuredClone(job)
  for (const step of copy.steps ?? [])
    if (step.name === fixtureStep)
      step.name = 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
  const log = evidence?.stepLog
  const fixed =
    log && job.steps.find((step) => step.number === log.number)?.name === fixtureStep
      ? {
          ...evidence,
          stepLog: {
            ...log,
            text: log.text.replace(/^.*##\[error\]Process completed with exit code 1\.?\r?$/gm, ''),
          },
        }
      : evidence
  const result = classifyJob(copy, fixed)
  if (result.kind === 'infra' && log) result.evidenceHash = evidenceHash(log.text)
  return result
}

export function controllerPlan(
  snapshot,
  readWorkflow,
  { now = Date.now(), rehearsal = false } = {},
) {
  const isFixture = rehearsal && snapshot.run.path === fixtureWorkflow
  if (
    snapshot.sourceBinding?.matched !== true ||
    snapshot.run.status !== 'completed' ||
    snapshot.run.run_attempt !== 1 ||
    snapshot.run.conclusion !== 'failure'
  )
    return planRecovery(snapshot, { now, paths: isFixture ? [fixtureWorkflow] : workflowPaths })
  const graph = buildRecoveryGraph(snapshot.run.path, snapshot.jobs, readWorkflow)
  const byName = new Map(graph.nodes.map((node) => [node.name, node]))
  const classifications = new Map(
    snapshot.jobs.map((job) => [
      job.id,
      fixtureClassification(job, snapshot.evidence[job.id], isFixture),
    ]),
  )
  for (const job of snapshot.jobs) {
    const result = classifications.get(job.id)
    if (!isFixture && result.kind === 'infra' && result.reason.startsWith('preparation-')) {
      const step = job.steps.find((item) => item.number === result.step)
      const declared = byName
        .get(job.name)
        .preparations?.find((item) => item.number === result.step)
      if (!declared || declared.name !== step.name || `Run ${declared.uses}` !== step.name)
        classifications.set(job.id, { kind: 'unknown', reason: 'preparation-command-not-bound' })
    }
  }
  const candidates = snapshot.jobs.filter((job) => classifications.get(job.id).kind === 'infra')
  for (const job of snapshot.jobs) {
    if (['passed', 'skipped', 'infra'].includes(classifications.get(job.id).kind)) continue
    const node = byName.get(job.name)
    if (!['summary', 'coordinator'].includes(node.role)) continue
    const failed =
      job.steps?.filter((step) => !['success', 'skipped'].includes(step.conclusion)) ?? []
    if (job.conclusion !== 'failure' || failed.length !== 1 || failed[0].conclusion !== 'failure')
      continue
    const log = snapshot.evidence[job.id]?.stepLog
    if (log?.number !== failed[0].number || log.complete !== true) continue
    const upstream = candidates.filter((root) => node.ancestors.includes(root.name))
    if (!upstream.length) continue
    const normal =
      node.dependencyGuard && failed[0].name === '阻断失败的上游' && log.text.includes(marker)
    const signing =
      node.apiWait &&
      node.signingWait &&
      failed[0].name === '同候选签名成功后再申请Mac' &&
      upstream.some(
        (root) => root.name === 'desktop-macos' && log.text.includes(`${marker}_JOB:${root.id}`),
      )
    if (!normal && !signing) continue
    classifications.set(job.id, {
      kind: 'dependent',
      reason: 'explicit-upstream-failure',
      evidenceHash: evidenceHash(log.text),
      step: failed[0].number,
    })
  }
  const plan = planRecovery(snapshot, {
    now,
    classify: (job) => classifications.get(job.id),
    paths: isFixture ? [fixtureWorkflow] : workflowPaths,
  })
  if (plan.decision !== 'eligible') return plan
  const closure = recoveryClosure(graph, plan.roots)
  const reject = (reason) => ({ ...plan, decision: 'blocked', reason, roots: [] })
  if (closure.some((node) => node.role === 'group'))
    return reject('unexpanded-call-in-recovery-closure')
  if (closure.some((node) => node.mac) && snapshot.activeMac.length)
    return { ...plan, decision: 'deferred', reason: 'other-mac-run-active', roots: [] }
  // job-rerun会重做下游，成功产品检查/安装包不得顺便重复；纯汇总可重新证明。
  if (closure.some((node) => node.actual?.conclusion === 'success' && node.role !== 'summary'))
    return reject('would-repeat-successful-work')
  const names = new Set(closure.map((node) => node.name))
  if (plan.jobs.some((job) => job.kind === 'dependent' && !names.has(job.name)))
    return reject('dependent-failure-outside-closure')
  // 协调器的API等待边不受job-rerun覆盖；多根或派生失败用同一次failed-jobs恢复。
  const failures = plan.jobs.filter((job) => ['infra', 'dependent'].includes(job.kind))
  const request =
    failures.length === 1 ? { kind: 'job', jobId: plan.roots[0].id } : { kind: 'failed-jobs' }
  return {
    ...plan,
    mode: 'recovery-plan',
    dependencyClosureVerified: true,
    graphDigest: graph.digest,
    request,
    closure: closure.map((node) => ({
      name: node.name,
      jobId: node.actual?.id ?? null,
      role: node.role,
    })),
    preservedJobs: snapshot.jobs
      .filter((job) => job.conclusion === 'success' && !names.has(job.name))
      .map((job) => ({ id: job.id, name: job.name, executionHash: executionHash(job) })),
  }
}

export function executionHash(job) {
  // GitHub在attempt2可能复制成功job并分配新ID；原runner与真实执行区间必须保持。
  return evidenceHash({
    started: job.started_at,
    ended: job.completed_at,
    runner: job.runner_name,
    steps: (job.steps ?? []).map(({ name, started_at, completed_at, conclusion }) => ({
      name,
      started_at,
      completed_at,
      conclusion,
    })),
  })
}
