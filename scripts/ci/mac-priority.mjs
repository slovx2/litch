// 只在Linux协调job等待同一候选的签名job结束；等待期间不占Mac名额。
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { gh } from './release-artifacts.mjs'

export class SigningFailure extends Error {
  constructor(jobId) {
    super('签名job失败，不放行补充Mac')
    this.jobId = jobId
  }
}

export function signingState(run, jobs, { repository, sha, runId, attempt }) {
  assert.equal(run.repository?.full_name, repository, '签名来源仓库')
  assert.equal(run.id, Number(runId), '签名来源run')
  assert.equal(run.head_sha, sha, '签名来源SHA')
  assert.equal(run.path, '.github/workflows/release.yml', '只有Prepare可等待签名')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.run_attempt, Number(attempt), '等待期间attempt改变')
  const found = jobs.filter((job) => job.name === 'desktop-macos')
  assert.ok(found.length <= 1, '签名job身份不唯一')
  const job = found[0]
  if (job?.status !== 'completed') {
    // 新的下游job入队时，workflow总状态可能回到queued，已有签名job仍在执行。
    assert.ok(['queued', 'in_progress'].includes(run.status), '候选结束而签名未成功')
    return null
  }
  if (job.conclusion !== 'success') throw new SigningFailure(job.id)
  assert.ok(job.run_attempt >= 1 && job.run_attempt <= Number(attempt))
  assert.ok(job.id > 0 && Number.isFinite(Date.parse(job.completed_at)))
  return { job: job.id, attempt: job.run_attempt, completedAt: job.completed_at }
}

export async function waitForSigning(
  context,
  { readRun, readJobs, sleep = delay, now = Date.now, limitMs = 70 * 60_000 },
) {
  const deadline = now() + limitMs
  while (now() < deadline) {
    const result = signingState(await readRun(), await readJobs(), context)
    if (result) return result
    await sleep(15_000)
  }
  throw new Error('等待候选签名超过70分钟，不申请补充Mac')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  const context = {
    repository: env.GITHUB_REPOSITORY,
    sha: env.CANDIDATE_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
  }
  const base = `repos/${context.repository}/actions/runs/${context.runId}`
  const result = await waitForSigning(context, {
    // 单次读取也有界，不能让卡住的网络请求绕过70分钟的状态等待上限。
    readRun: () => JSON.parse(gh(['api', base], { timeout: 30_000 })),
    // filter=latest保留前次attempt已经成功且本次未重跑的签名job；仍只接受同run同SHA。
    readJobs: () =>
      JSON.parse(
        gh(['api', '--paginate', '--slurp', `${base}/jobs?filter=latest&per_page=100`], {
          timeout: 30_000,
        }),
      ).flatMap((page) => page.jobs),
  }).catch((error) => {
    if (error instanceof SigningFailure)
      console.error(`::error::LITCH_RECOVERY_UPSTREAM_FAILURE_JOB:${error.jobId}`)
    throw error
  })
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `\n签名优先：同SHA的desktop-macos #${result.job}（attempt ${result.attempt}）于${result.completedAt}成功后放行本候选补充Mac。\n`,
  )
}
