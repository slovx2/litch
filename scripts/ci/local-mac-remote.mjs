import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkEnvelope, checkHistory, checkSource } from './local-mac-policy.mjs'
import {
  api,
  archiveNames,
  download,
  fileHash,
  pages,
  validateArtifact,
} from './release-artifacts.mjs'

export async function readSmallArtifact(repository, artifact, filename) {
  const limit = 256 * 1024
  assert.ok(artifact.size_in_bytes <= limit)
  const temp = mkdtempSync(join(tmpdir(), 'litch-local-proof-'))
  try {
    const zip = join(temp, 'proof.zip')
    await download(
      `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
      zip,
      process.env.GH_TOKEN,
      limit,
    )
    assert.equal(`sha256:${await fileHash(zip)}`, artifact.digest)
    assert.deepEqual(archiveNames(zip), [filename])
    return JSON.parse(
      execFileSync('unzip', ['-p', zip, filename], { encoding: 'utf8', maxBuffer: limit }),
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export function sourceState(context, { read = api, list = pages } = {}) {
  const base = `repos/${context.repository}`
  const run = read(`${base}/actions/runs/${context.runId}`)
  const branch = read(`${base}/branches/${encodeURIComponent(run.head_branch)}`)
  checkSource(run, context, branch)
  const jobs = list(`${base}/actions/runs/${context.runId}/jobs?filter=all&per_page=100`, 'jobs')
  const names = jobs
    .filter((job) => /(?:^| \/ )(native|browser) \/ checks$/.test(job.name))
    .map((job) => job.name)
  assert.equal(new Set(names).size, 1, '必须只有一套合并Mac检查')
  const name = names[0]
  const history = jobs
    .filter((job) => job.name === name)
    .map((job) => {
      assert.equal(job.run_id, context.runId)
      assert.equal(job.head_sha, context.sha)
      const failed = ['failure', 'cancelled', 'timed_out'].includes(job.conclusion)
      if (failed) {
        const check = read(`${base}/check-runs/${job.id}`)
        assert.equal(check.id, job.id)
        assert.equal(check.head_sha, context.sha)
        assert.equal(check.app?.slug, 'github-actions', '失败标注必须来自GitHub Actions')
      }
      return {
        ...job,
        annotations: failed ? list(`${base}/check-runs/${job.id}/annotations?per_page=100`) : [],
      }
    })
  const route = jobs
    .filter((job) => job.name === name.replace(/checks$/, 'route') && job.conclusion === 'success')
    .sort((a, b) => b.run_attempt - a.run_attempt)[0]
  assert.ok(route, '来源缺少成功的Mac路由job')
  return { run, branch, history, name, routeId: route.id }
}

export function validateLocal(envelope, publicKey, context, selected) {
  const payload = checkEnvelope(envelope, publicKey, context, selected)
  const state = sourceState(context)
  checkHistory(state.history, payload.source, state.name)
  assert.ok(payload.source.attempt <= state.run.run_attempt)
  return payload
}

// 只接收本run、同SHA、受保护分支的专用收据，不把任意上传文件当作Actions检查。
export async function findReceipt(context, selected) {
  const key = process.env.LITCH_LOCAL_MAC_PUBLIC_KEY
  if (!key) return null
  const base = `repos/${context.repository}`
  const runs = pages(
    `${base}/actions/workflows/local-mac-proof.yml/runs?head_sha=${context.sha}&event=workflow_dispatch&status=success&per_page=100`,
    'workflow_runs',
  )
  for (const run of runs) {
    if (
      run.path !== '.github/workflows/local-mac-proof.yml' ||
      run.head_sha !== context.sha ||
      run.conclusion !== 'success' ||
      run.event !== 'workflow_dispatch'
    )
      continue
    const listed = pages(`${base}/actions/runs/${run.id}/artifacts?per_page=100`, 'artifacts')
    const name = `local-mac-${context.runId}-${run.run_attempt}`
    const matches = listed.filter((item) => item.name === name && !item.expired)
    if (!matches.length) continue
    assert.equal(matches.length, 1)
    const artifact = validateArtifact(matches[0], { run: run.id, sha: context.sha, name })
    const jobs = pages(
      `${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
      'jobs',
    )
    assert.equal(
      jobs.filter((job) => job.name === 'accept' && job.conclusion === 'success').length,
      1,
    )
    const envelope = await readSmallArtifact(
      context.repository,
      artifact,
      'local-mac-envelope.json',
    )
    const payload = validateLocal(envelope, key, context, selected)
    return {
      envelope,
      payload,
      artifact: { id: artifact.id, digest: artifact.digest, runId: run.id },
    }
  }
  return null
}
