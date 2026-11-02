// 用户决定：夜间手机 E2E 失败进入修复项，不能自动挂 release-blocker。
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { hasAllDomains } from '../full-proof.mjs'
import { readFullProofArtifact } from '../full-proof-artifact.mjs'
import { api, pages } from './release-artifacts.mjs'

export function mobileFailure(run, proof, repository) {
  assert.equal(run.path, '.github/workflows/full.yml')
  assert.equal(run.event, 'schedule')
  assert.equal(run.status, 'completed')
  assert.equal(proof?.schema, 1, '缺少可信 Full 证明')
  assert.equal(proof.repository, repository)
  assert.equal(proof.runId, run.id)
  assert.equal(proof.attempt, run.run_attempt)
  assert.equal(proof.event, run.event)
  assert.equal(proof.workflowSha, run.head_sha)
  assert.equal(proof.sha, run.head_sha)
  assert.equal(proof.runCi, true)
  assert.ok(hasAllDomains(proof.domains))
  return ['mobile', 'mobile-build'].filter((job) =>
    ['failure', 'cancelled', 'timed_out'].includes(proof.jobs?.[job]),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repo = process.env.GITHUB_REPOSITORY
  assert.match(process.env.NIGHTLY_RUN ?? '', /^[1-9][0-9]*$/)
  const run = api(`repos/${repo}/actions/runs/${process.env.NIGHTLY_RUN}`)
  assert.equal(run.repository.full_name, repo)
  const proof = await readFullProofArtifact(repo, run, api)
  const failed = mobileFailure(run, proof, repo)
  if (failed.length) {
    const title = `[nightly-mobile] Full #${run.id} 手机回归需修复`
    const existing = pages(`repos/${repo}/issues?state=all&per_page=100`).find(
      (issue) => issue.title === title,
    )
    const issue =
      existing ||
      api(`repos/${repo}/issues`, {
        title,
        body: `夜间手机检查失败：${run.html_url}\n\nSHA：${run.head_sha}\nAttempt：${run.run_attempt}\n失败领域：${failed.join(', ')}\n\n按用户决定，此项跟进手机可靠性，不因手机模拟器失败阻断发版。其他领域、手机单测/类型、APK 签名与包验证仍按原规则；本记录不构成其他失败的豁免。`,
      })
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n手机修复项：${issue.html_url}\n`)
  }
}
