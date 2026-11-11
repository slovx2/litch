// 下载同run的成功检查制品，核对artifact摘要与来源job后才交给Full汇总。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkLinuxProof, linuxSources } from './linux-proof.mjs'
import { checkNativeProof } from './mac-native-plan.mjs'
import { api, archiveNames, download, fileHash, pages } from './release-artifacts.mjs'
import { checkJob, chooseArtifact } from './release-candidate.mjs'
import { readJobs } from './release-jobs.mjs'
import { checkWindowsProof, windowsSource } from './windows-proof.mjs'

const env = process.env
const selected = JSON.parse(env.NATIVE_DOMAINS)
const sources = linuxSources(env.FULL_DOMAINS ?? '', env.FULL_RUN_CI === 'true')
const bound = { macProof: null, linuxProofs: {}, windowsProof: null }
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
// Linux报告包含实际Node用例名称；2MiB边界覆盖该清单，但不接受任意大归档。
const limit = 2 * 1024 * 1024
async function readProof(kind, filename, job, validate) {
  const artifact = chooseArtifact(listed, kind, context)
  assert.ok(listed.find((item) => item.id === artifact.id).size_in_bytes <= limit)
  artifact.jobId = checkJob(
    await readJobs(`${base}/attempts/${artifact.attempt}/jobs`),
    `${prefixes[run.path]}${job}`,
    artifact.attempt,
  )
  const temp = mkdtempSync(join(tmpdir(), 'litch-check-proof-'))
  try {
    const file = join(temp, 'proof.zip')
    await download(
      `https://api.github.com/repos/${context.repository}/actions/artifacts/${artifact.id}/zip`,
      file,
      env.GH_TOKEN,
      limit,
    )
    assert.equal(`sha256:${await fileHash(file)}`, artifact.digest)
    assert.deepEqual(archiveNames(file), [filename])
    const proof = JSON.parse(
      execFileSync('unzip', ['-p', file, filename], { encoding: 'utf8', maxBuffer: limit }),
    )
    validate(proof, {
      ...context,
      sha: env.FULL_SOURCE_SHA,
      workflowSha: env.GITHUB_SHA,
      attempt: artifact.attempt,
    })
    return { artifact, proof }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
if (selected.length)
  bound.macProof = await readProof(
    'mac-native-proof',
    'mac-native-proof.json',
    'native / checks',
    (proof, source) => checkNativeProof(proof, selected, source),
  )
for (const source of sources)
  bound.linuxProofs[source.kind] = await readProof(
    source.kind,
    'checks.json',
    source.job,
    (proof, context) => checkLinuxProof(proof, source.suites, context),
  )
if (env.FULL_RUN_CI === 'true')
  bound.windowsProof = await readProof(
    windowsSource.kind,
    'checks.json',
    windowsSource.job,
    checkWindowsProof,
  )
writeFileSync('check-proofs-bound.json', `${JSON.stringify(bound)}\n`)
