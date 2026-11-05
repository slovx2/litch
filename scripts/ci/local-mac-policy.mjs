// 本地证明只是受信维护者的签名声明；GitHub 的原始失败证据必须另外读取。
import assert from 'node:assert/strict'
import { createPublicKey, verify } from 'node:crypto'
import { goToolchain } from './go-toolchains.mjs'
import { checkNativeProof } from './mac-native-plan.mjs'

export const capacityMessage =
  'The job was not acquired by Runner of type hosted even after multiple attempts'
export const allowedWorkflows = ['ci', 'full', 'gate', 'release'].map(
  (name) => `.github/workflows/${name}.yml`,
)

export function checkSource(run, { repository, sha, runId }, branch) {
  assert.equal(run.repository?.full_name, repository)
  assert.equal(run.head_repository?.full_name, repository, '不接受fork来源')
  assert.equal(run.id, runId)
  assert.equal(run.head_sha, sha, '来源SHA不同')
  assert.ok(allowedWorkflows.includes(run.path), '不支持的来源工作流')
  assert.ok(['push', 'workflow_dispatch', 'schedule'].includes(run.event), '不接受PR来源')
  assert.ok(run.head_branch === 'main' || /^release\/\d+\.\d+\.\d+$/.test(run.head_branch))
  assert.equal(branch.protected, true, '来源分支必须受保护')
}

export function checkCapacity(job, annotations) {
  assert.equal(job.status, 'completed')
  assert.ok(['failure', 'cancelled'].includes(job.conclusion))
  assert.equal(job.runner_id, 0, '已经执行的产品失败不能覆盖')
  assert.ok(!job.runner_name)
  assert.deepEqual(job.steps, [])
  const failures = annotations.filter((item) => item.annotation_level === 'failure')
  assert.ok(failures.length > 0, '缺少GitHub容量失败标注')
  assert.ok(
    failures.every((item) => item.message === capacityMessage),
    '非容量类失败',
  )
}

export function checkEnvelope(envelope, publicKey, context, selected) {
  assert.equal(envelope?.schema, 1)
  assert.equal(typeof envelope.payload, 'string')
  assert.ok(Buffer.byteLength(envelope.payload) < 44000)
  const key = createPublicKey(publicKey)
  assert.equal(key.asymmetricKeyType, 'ed25519')
  assert.equal(
    verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64')),
    true,
    '本地证明签名无效',
  )
  const payload = JSON.parse(envelope.payload)
  assert.equal(payload.schema, 1)
  assert.equal(payload.source.runId, context.runId)
  assert.equal(payload.source.sha, context.sha)
  assert.equal(payload.source.repository, context.repository)
  assert.ok(Number.isSafeInteger(payload.source.attempt) && payload.source.attempt > 0)
  assert.ok(Number.isSafeInteger(payload.source.jobId) && payload.source.jobId > 0)
  assert.equal(payload.environment.platform, 'darwin')
  assert.equal(payload.environment.arch, 'arm64')
  assert.equal(payload.environment.node, 'v24.21.0')
  assert.equal(payload.environment.go, `go version ${goToolchain()} darwin/arm64`)
  if (selected.includes('ios'))
    assert.equal(payload.environment.mobileGo, `go version ${goToolchain('mobile')} darwin/arm64`)
  for (const field of ['os', 'xcode', 'sdk']) assert.ok(payload.environment[field]?.trim())
  if (payload.proof.ios?.ready) assert.equal(payload.environment.ruby, '3.4.7')
  assert.ok(Number.isFinite(Date.parse(payload.startedAt)))
  assert.ok(Date.parse(payload.completedAt) >= Date.parse(payload.startedAt))
  checkNativeProof(payload.proof, selected, {
    ...context,
    attempt: payload.source.attempt,
    workflowSha: context.sha,
  })
  return payload
}

// 曾经真正执行失败就永久拒绝本地覆盖，不能先重跑成容量失败再洗掉产品失败。
export function checkHistory(history, source, selectedJobName) {
  const original = history.find((job) => job.id === source.jobId)
  assert.ok(original && original.name === selectedJobName, '来源job不符')
  assert.equal(original.run_attempt, source.attempt)
  for (const job of history.filter((item) => item.name === selectedJobName)) {
    if (job.status === 'completed' && !['success', 'skipped'].includes(job.conclusion))
      checkCapacity(job, job.annotations)
  }
  checkCapacity(original, original.annotations)
  return original
}
