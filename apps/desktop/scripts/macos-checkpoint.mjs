// Accepted 检查点只供票据恢复，绝不是可分发候选。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  api,
  downloadArtifact,
  fileHash,
  pages,
  validateArtifact,
} from '../../../scripts/ci/release-artifacts.mjs'
import { readJobs } from '../../../scripts/ci/release-jobs.mjs'
import { staple } from './notarize.mjs'

const run = (command, args) => execFileSync(command, args, { encoding: 'utf8' })
const json = (path) => JSON.parse(readFileSync(path, 'utf8'))
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
export const acceptedStep = '签名并公证到 Accepted 检查点'
export const uploadStep = '上传 Accepted 检查点（不可分发）'

export function checkpointContext(env = process.env) {
  return {
    repository: env.GITHUB_REPOSITORY,
    sha: env.CANDIDATE_SHA || env.GITHUB_SHA,
    run: env.GITHUB_RUN_ID,
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
    version: json('package.json').version,
    arch: process.arch,
  }
}

export function checkCheckpoint(proof, context) {
  assert.equal(proof.schema, 1)
  assert.equal(proof.state, 'Accepted')
  for (const key of ['repository', 'sha', 'run', 'version', 'arch'])
    assert.equal(proof[key], context[key], `检查点 ${key}`)
  assert.match(proof.sha, /^[a-f0-9]{40}$/)
  assert.match(proof.run, /^[1-9]\d*$/)
  assert.ok(
    Number.isSafeInteger(proof.attempt) && proof.attempt >= 1 && proof.attempt <= context.attempt,
    '检查点 attempt',
  )
  assert.match(proof.submission, /^[a-f0-9-]{36}$/i)
  assert.match(proof.team, /^[A-Z0-9]{10}$/)
  assert.deepEqual(
    Object.keys(proof.files).sort(),
    ['signed-app.zip', `Litch-${context.version}-macos-${context.arch}.dmg`].sort(),
  )
  for (const hash of Object.values(proof.files)) assert.match(hash, /^[a-f0-9]{64}$/)
  return proof
}

function signedTeam(file) {
  run('codesign', ['--verify', '--deep', '--strict', file])
  // execFileSync 成功不会返回 stderr，直接以 spawnSync 同时捕获。
  const result = signedDetails(file)
  assert.equal(result.status, 0, '签名详情读取失败')
  const found = /TeamIdentifier=([A-Z0-9]{10})\b/.exec(result.stderr)
  assert.ok(found, '缺少正式签名团队')
  return found[1]
}

const signedDetails = (file) =>
  spawnSync('codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' })

export async function saveCheckpoint(dir, app, dmg, submission, context = checkpointContext()) {
  mkdirSync(dir, { recursive: true })
  const appTeam = signedTeam(app)
  assert.equal(signedTeam(dmg), appTeam)
  const dmgName = `Litch-${context.version}-macos-${context.arch}.dmg`
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(dir, 'signed-app.zip')])
  copyFileSync(dmg, join(dir, dmgName))
  const files = {}
  for (const name of ['signed-app.zip', dmgName]) files[name] = await fileHash(join(dir, name))
  const proof = checkCheckpoint(
    { schema: 1, state: 'Accepted', ...context, submission, team: appTeam, files },
    context,
  )
  write(join(dir, 'checkpoint.json'), proof)
  return proof
}

export async function verifyCheckpoint(dir, context) {
  const proof = checkCheckpoint(json(join(dir, 'checkpoint.json')), context)
  for (const [name, hash] of Object.entries(proof.files))
    assert.equal(await fileHash(join(dir, name)), hash, `检查点 hash ${name}`)
  return proof
}

export async function restoreCheckpoint(dir, out, context = checkpointContext()) {
  const proof = await verifyCheckpoint(dir, context)
  const appDir = join(out, `Litch-darwin-${context.arch}`)
  const app = join(appDir, 'Litch.app')
  const dmg = join(out, 'installer', `Litch-${context.version}-macos-${context.arch}.dmg`)
  mkdirSync(appDir, { recursive: true })
  mkdirSync(join(out, 'installer'), { recursive: true })
  run('ditto', ['-x', '-k', join(dir, 'signed-app.zip'), appDir])
  copyFileSync(join(dir, `Litch-${context.version}-macos-${context.arch}.dmg`), dmg)
  assert.equal(signedTeam(app), proof.team)
  assert.equal(signedTeam(dmg), proof.team)
  return { proof, app, dmg }
}

export function checkCheckpointJob(jobs, attempt) {
  const matches = jobs.filter((job) => job.name === 'desktop-macos')
  assert.equal(matches.length, 1, '检查点来源 job')
  const job = matches[0]
  assert.equal(job.run_attempt, attempt)
  for (const name of [acceptedStep, uploadStep])
    assert.ok(
      job.steps.some((step) => step.name === name && step.conclusion === 'success'),
      `检查点步骤未成功：${name}`,
    )
  return job.id
}

export function hasAttemptedNotarization(jobs) {
  return jobs.some(
    (job) =>
      job.name === 'desktop-macos' &&
      job.steps.some(
        (step) =>
          step.name === acceptedStep &&
          ['success', 'failure', 'cancelled', 'timed_out'].includes(step.conclusion),
      ),
  )
}

export async function findCheckpoint(dir, context = checkpointContext()) {
  const base = `repos/${context.repository}/actions/runs/${context.run}`
  const found = pages(`${base}/artifacts?per_page=100`, 'artifacts')
    .filter((a) => /^macos-notarized-[1-9]\d*$/.test(a.name))
    .sort((a, b) => Number(b.name.split('-').at(-1)) - Number(a.name.split('-').at(-1)))
  if (!found.length) {
    // 已经到达 Accepted 后不允许因检查点丢失而重新公证。
    if (context.attempt > 1) {
      const jobs = await readJobs(`${base}/jobs?filter=all`)
      assert.ok(
        !hasAttemptedNotarization(jobs),
        '既有公证步骤已执行但检查点缺失，禁止重新提交；先检查原始日志',
      )
    }
    return false
  }
  const artifact = found[0]
  const attempt = Number(artifact.name.split('-').at(-1))
  assert.ok(attempt < context.attempt, '检查点必须来自本 run 的较早 attempt')
  assert.equal(found.filter((a) => a.name === artifact.name).length, 1)
  validateArtifact(artifact, { run: context.run, sha: context.sha, name: artifact.name })
  const jobId = checkCheckpointJob(await readJobs(`${base}/attempts/${attempt}/jobs`), attempt)
  mkdirSync(dir, { recursive: true })
  await downloadArtifact(context.repository, artifact, dir)
  const proof = await verifyCheckpoint(dir, context)
  assert.equal(proof.attempt, attempt)
  write(join(dir, 'source.json'), {
    id: artifact.id,
    name: artifact.name,
    digest: artifact.digest,
    attempt,
    jobId,
  })
  return true
}

export async function finishCheckpoint(
  dir,
  out,
  context = checkpointContext(),
  {
    restore = restoreCheckpoint,
    execute = run,
    stapleFile = staple,
    summary = process.env.GITHUB_STEP_SUMMARY,
  } = {},
) {
  const { proof, app, dmg } = await restore(dir, out, context)
  const source = json(join(dir, 'source.json'))
  assert.equal(source.attempt, proof.attempt)
  const info = JSON.parse(
    execute('xcrun', [
      'notarytool',
      'info',
      proof.submission,
      '--keychain-profile',
      process.env.LITCH_NOTARY_PROFILE,
      '--keychain',
      process.env.LITCH_NOTARY_KEYCHAIN,
      '--output-format',
      'json',
    ]),
  )
  assert.equal(info.id, proof.submission)
  assert.equal(info.status, 'Accepted', '恢复前必须重新确认 Accepted')
  if (summary)
    appendFileSync(
      summary,
      `\n## Accepted 检查点\n\nSHA ${proof.sha}；公证 UUID ${proof.submission}；公证 attempt ${proof.attempt}；当前票据验证 attempt ${context.attempt}；检查点 artifact ${source.id} / ${source.digest}。Apple 状态再次查询为 Accepted，以下票据仍须成功；不重新签名或提交公证。\n`,
    )
  stapleFile(dmg)
  stapleFile(app)
  execute('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  execute('spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=2',
    dmg,
  ])
  write(join(dir, 'validated.json'), {
    ...proof,
    validatedAttempt: context.attempt,
    artifact: source,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dir, out] = process.argv.slice(2)
  if (mode === 'find') {
    const found = await findCheckpoint(dir)
    appendFileSync(process.env.GITHUB_OUTPUT, `restored=${found}\n`)
  } else if (mode === 'bind') {
    const context = checkpointContext()
    const artifact = validateArtifact(
      api(`repos/${context.repository}/actions/artifacts/${process.env.CHECKPOINT_ID}`),
      {
        run: context.run,
        sha: context.sha,
        name: `macos-notarized-${context.attempt}`,
        digest: process.env.CHECKPOINT_DIGEST.startsWith('sha256:')
          ? process.env.CHECKPOINT_DIGEST
          : `sha256:${process.env.CHECKPOINT_DIGEST}`,
      },
    )
    write(join(dir, 'source.json'), {
      id: artifact.id,
      name: artifact.name,
      digest: artifact.digest,
      attempt: context.attempt,
    })
  } else if (mode === 'finish') await finishCheckpoint(dir, out)
  else throw new Error('macos-checkpoint: find|finish DIR [OUT]')
}
