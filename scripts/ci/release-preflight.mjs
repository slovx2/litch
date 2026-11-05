// 同 SHA 已经完成候选时禁止再次整轮构建；重跑失败 job 仍在原 run 内完成。
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { checkVersion } from '../release-policy.mjs'
import { bypassReason } from './gate-bypass.mjs'
import { api, pages } from './release-artifacts.mjs'
import { readJson } from './release-candidate.mjs'

export function existingCandidate(runs, artifacts, { sha, currentRun }) {
  for (const run of runs) {
    if (
      String(run.id) === String(currentRun) ||
      run.head_sha !== sha ||
      run.conclusion !== 'success' ||
      run.path !== '.github/workflows/release.yml' ||
      run.event !== 'workflow_dispatch'
    )
      continue
    const ready = artifacts(run).filter(
      (a) => !a.expired && a.name === `verified-candidate-${run.run_attempt}`,
    )
    // 增量基线过期时在原 run 补跑 Gate；不能重新构建仍在留存期内的成功包。
    if (ready.length)
      return { run: run.id, attempt: run.run_attempt, artifact: ready[0].id, url: run.html_url }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bypassReason()
  const repo = process.env.GITHUB_REPOSITORY
  const version = readJson('package.json').version
  checkVersion(`v${version}`)
  const runs = pages(
    `repos/${repo}/actions/workflows/release.yml/runs?head_sha=${process.env.GITHUB_SHA}&status=success&per_page=100`,
    'workflow_runs',
  )
  const previous = existingCandidate(
    runs,
    (run) => api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts,
    { sha: process.env.GITHUB_SHA, currentRun: process.env.GITHUB_RUN_ID },
  )
  if (previous) {
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n同 SHA 已有候选，请用 Promote：${JSON.stringify(previous)}\n`,
      )
    throw new Error(`同 SHA 已完成 Prepare #${previous.run}，禁止重复构建；请晋级原候选`)
  }
}
