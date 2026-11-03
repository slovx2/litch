// 只供受审的recovery-controller入口调用；默认关闭，演练只允许固定分支的同SHA fixture。
import assert from 'node:assert/strict'
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { latestState, saveState } from './maintenance-state.mjs'
import { checkControllerRun, recoverRun } from './recovery-controller.mjs'
import { githubReader, localWorkflowContract, observeRun, readPages } from './recovery-observe.mjs'
import { evidenceHash } from './recovery-policy.mjs'
import { recordScanned, selectRecoveryBatch } from './recovery-scan.mjs'
import { githubWriter } from './recovery-write.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const base = 'repos/slovx2/litch'
export function recoveryFailureLocation(error) {
  // 只输出受审模块和行列，不输出异常消息、API响应、绝对路径或环境。
  const modules = new Set(readdirSync(join(root, 'scripts/ci')))
  for (const line of String(error?.stack ?? '')
    .split('\n')
    .slice(1)) {
    const match = line.match(/\/(recovery-[a-z-]+\.mjs):(\d{1,6}):(\d{1,6})(?:\)|$)/)
    if (match && modules.has(match[1])) return `${match[1]}:${match[2]}:${match[3]}`
  }
  return 'unknown'
}
export function recoveryContract() {
  const paths = [
    'package.json',
    'package-lock.json',
    'scripts/ci/mac-priority.mjs',
    'scripts/ci/maintenance-state.mjs',
    ...readdirSync(join(root, 'scripts/ci'))
      .filter(
        (name) =>
          name.startsWith('recovery-') && name.endsWith('.mjs') && !name.endsWith('.test.mjs'),
      )
      .sort()
      .map((name) => `scripts/ci/${name}`),
  ]
  return {
    ...localWorkflowContract(),
    ...Object.fromEntries(
      paths.map((path) => [path, evidenceHash(readFileSync(join(root, path), 'utf8'))]),
    ),
  }
}

export function runController(
  env = process.env,
  { read = githubReader(), write = githubWriter() } = {},
) {
  assert.equal(env.GITHUB_ACTIONS, 'true', '写控制器只能在GitHub受审入口运行')
  assert.equal(env.GITHUB_REPOSITORY, 'slovx2/litch')
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/)
  assert.equal(env.GITHUB_RUN_ATTEMPT, '1')
  const run = read(`${base}/actions/runs/${env.GITHUB_RUN_ID}`)
  const metadata = read(base)
  const manual = run.event === 'workflow_dispatch'
  const rehearsal = manual && run.head_branch === 'ci/recovery-nightly'
  const context = {
    runId: Number(env.GITHUB_RUN_ID),
    sha: env.GITHUB_SHA,
    attempt: 1,
    defaultBranch: metadata.default_branch,
    rehearsal,
  }
  checkControllerRun(run, context)
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `slovx2/litch/.github/workflows/recovery-controller.yml@refs/heads/${run.head_branch}`,
  )
  const enabled = manual
    ? rehearsal && env.RECOVERY_MODE === 'fixture-recover'
    : env.LITCH_CI_RECOVERY_ENABLED === 'true'
  const contract = recoveryContract()
  const services = {
    read,
    write,
    controller: context,
    enabled,
    readWorkflow: (path) => readFileSync(join(root, path), 'utf8'),
    observe: (runId) =>
      observeRun(runId, {
        read,
        contract,
        includeSnapshot: true,
        ...(rehearsal ? { rehearsalSource: { ref: 'ci/recovery-nightly', sha: context.sha } } : {}),
      }),
  }
  let sources
  if (run.event === 'schedule') {
    if (!enabled) return [{ state: 'disabled' }]
    const previous = latestState(read, 'ci-recovery-scan', {
      defaultBranch: metadata.default_branch,
      currentRun: run.id,
    })
    // 以实际结束时间选窗口；长Full不能因创建时间超过2小时就漏掉。
    const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    const candidates = readPages(
      read,
      `${base}/actions/runs?branch=${encodeURIComponent(metadata.default_branch)}&created=${encodeURIComponent(`>=${since}`)}`,
      'workflow_runs',
    )
    return reconcileRecoverySources(candidates, previous?.value, services, {
      defaultBranch: metadata.default_branch,
      save: (state) => saveState('ci-recovery-scan', state, run),
    })
  } else {
    assert.match(env.RECOVERY_SOURCE_RUN ?? '', /^[1-9][0-9]*$/)
    sources = [Number(env.RECOVERY_SOURCE_RUN)]
  }
  return sources.map((source) => recoverRun(source, services))
}

export function reconcileRecoverySources(
  runs,
  previous,
  services,
  { defaultBranch = 'main', save, recover = recoverRun, now = Date.now() },
) {
  const batch = selectRecoveryBatch(runs, previous, { defaultBranch, now })
  // 在任何恢复写入前固化本轮最多五个来源。后续才能证明其他来源未被这轮处理。
  let state = { ...batch.state, selectedRunIds: batch.selected.map((source) => source.id) }
  const results = [{ state: previous ? 'checkpoint-loaded' : 'checkpoint-bootstrap' }]
  save(state)
  for (const source of batch.selected) {
    let result
    try {
      result = recover(source.id, services)
    } catch {
      result = {
        state: 'controller-error',
        runId: source.id,
        reason: '只读或审计检查失败；不重试写请求',
      }
    }
    state = recordScanned(state, source, result, now)
    save(state)
    results.push(result)
  }
  if (batch.remaining.length)
    results.push({
      state: 'reconcile-limit-reached',
      remaining: batch.remaining,
      reason: '每轮最多五来源，下轮从游标之后继续，不把剩余项当作已处理',
    })
  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const results = runController()
    // 输出仅分类/来源/状态；observe不返回原始日志。
    console.log(JSON.stringify(results, null, 2))
    if (results.some((result) => result.state === 'controller-error')) process.exitCode = 1
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## 基础设施恢复控制器\n\n产品断言重试：0。写前reservation，每源run最多一轮。\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`,
      )
  } catch (error) {
    console.error('恢复控制器停止：来源、审计、API或范围检查未通过。预算不重置，不盲目重跑。')
    console.error(`CI_RECOVERY_FAILURE_AT ${recoveryFailureLocation(error)}`)
    process.exitCode = 1
  }
}
