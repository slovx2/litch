// 下载同run的成功Mac检查证明，核对artifact摘要与来源job后才交给Full汇总。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkNativeProof } from './mac-native-plan.mjs'
import { api, archiveNames, download, fileHash, pages } from './release-artifacts.mjs'
import { checkJob, chooseArtifact } from './release-candidate.mjs'

const env = process.env
const selected = JSON.parse(env.NATIVE_DOMAINS)
let bound = null
if (selected.length) {
  const context = {
    repository: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
  }
  const base = `repos/${context.repository}/actions/runs/${context.runId}`
  const run = api(base)
  const prefixes = {
    '.github/workflows/full.yml': '',
    '.github/workflows/gate.yml': 'tests / ',
    '.github/workflows/release.yml': 'gate / tests / ',
  }
  assert.ok(Object.hasOwn(prefixes, run.path), '不认识的Full调用来源')
  const listed = pages(`${base}/artifacts?per_page=100`, 'artifacts')
  const artifact = chooseArtifact(listed, 'mac-native-proof', context)
  assert.ok(listed.find((item) => item.id === artifact.id).size_in_bytes <= 128 * 1024)
  artifact.jobId = checkJob(
    pages(`${base}/attempts/${artifact.attempt}/jobs?per_page=100`, 'jobs'),
    `${prefixes[run.path]}native / checks`,
    artifact.attempt,
  )
  const temp = mkdtempSync(join(tmpdir(), 'litch-mac-proof-'))
  try {
    const file = join(temp, 'proof.zip')
    await download(
      `https://api.github.com/repos/${context.repository}/actions/artifacts/${artifact.id}/zip`,
      file,
      env.GH_TOKEN,
      128 * 1024,
    )
    assert.equal(`sha256:${await fileHash(file)}`, artifact.digest)
    assert.deepEqual(archiveNames(file), ['mac-native-proof.json'])
    const proof = JSON.parse(
      execFileSync('unzip', ['-p', file, 'mac-native-proof.json'], {
        encoding: 'utf8',
        maxBuffer: 128 * 1024,
      }),
    )
    checkNativeProof(proof, selected, {
      ...context,
      sha: env.FULL_SOURCE_SHA,
      workflowSha: env.GITHUB_SHA,
      attempt: artifact.attempt,
    })
    bound = { artifact, proof }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
writeFileSync('mac-proof-bound.json', `${JSON.stringify(bound)}\n`)
