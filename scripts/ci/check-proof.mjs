// 逐项验证共享执行器的实际平台、检查集合、来源和零跳过结果。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkPlan, expectsNodeTests } from './check-catalog.mjs'
import { cliPackages } from './install-test-clis.mjs'

export function checkExecutionProof(proof, names, context, platform) {
  const plan = checkPlan(names)
  assert.equal(proof?.schema, 1)
  assert.equal(proof.repository, context.repository)
  assert.equal(proof.sha, context.sha)
  assert.equal(proof.runId, String(context.runId))
  assert.equal(proof.attempt, context.attempt)
  assert.equal(proof.platform, platform)
  assert.equal(proof.arch, 'x64')
  assert.equal(proof.node, 'v24.21.0')
  assert.equal(proof.complete, true)
  assert.deepEqual(proof.plan, plan)
  const versions = JSON.parse(
    readFileSync(new URL('../../protocol/versions.json', import.meta.url)),
  )
  assert.deepEqual(proof.versions, versions)
  const specs = cliPackages(versions)
  assert.deepEqual(
    proof.clis,
    plan.clis.map((id) => ({ id, package: specs[id].name, version: specs[id].version })),
  )
  assert.deepEqual(
    proof.results.map((item) => item.id),
    plan.checks.map((item) => item.id),
  )
  for (const item of proof.results) {
    assert.equal(item.code, 0)
    assert.equal(item.signal, null)
    assert.equal(item.tests.fail + item.tests.cancelled + item.tests.skipped, 0)
    if (expectsNodeTests(item.id)) assert.ok(item.tests.tests > 0 && item.tests.names.length > 0)
  }
  return proof
}
