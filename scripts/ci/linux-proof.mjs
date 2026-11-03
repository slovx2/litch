// Full复用CI首回合必须带真实检查制品，不能只用调用job的success代替检查身份。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { domains as fullDomains } from '../ci-impact.mjs'
import { checkPlan, expectsNodeTests } from './check-catalog.mjs'
import { cliPackages } from './install-test-clis.mjs'

export function linuxSources(domains, runCi) {
  const selected = domains.trim() ? JSON.parse(domains) : fullDomains
  const sources = []
  if (runCi)
    sources.push({
      kind: 'linux-checks-ci-client',
      job: 'gate / client / checks',
      suites: ['desktop-portable-unit', 'desktop-required'],
      needs: 'gate',
    })
  if (selected.includes('real-engines'))
    sources.push({
      kind: 'linux-checks-real-engines',
      job: 'real-engines / checks',
      suites: [runCi ? 'real-engine-tools' : 'real-engines'],
      needs: 'real-engines',
    })
  if (!runCi && selected.includes('client'))
    sources.push({
      kind: 'linux-checks-full-client-unit',
      job: 'client-unit / checks',
      suites: ['desktop-portable-unit'],
      needs: 'client-unit',
    })
  return sources
}

export function checkLinuxProof(proof, names, context) {
  const plan = checkPlan(names)
  assert.equal(proof?.schema, 1)
  assert.equal(proof.repository, context.repository)
  assert.equal(proof.sha, context.sha)
  assert.equal(proof.runId, String(context.runId))
  assert.equal(proof.attempt, context.attempt)
  assert.equal(proof.platform, 'linux')
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

export function hasLinuxCoverage(full) {
  try {
    const sources = linuxSources(full.domains, full.runCi)
    assert.deepEqual(Object.keys(full.linuxProofs).sort(), sources.map((s) => s.kind).sort())
    for (const source of sources) {
      assert.equal(full.jobs[source.needs], 'success')
      const { artifact, proof } = full.linuxProofs[source.kind]
      assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0)
      assert.ok(Number.isSafeInteger(artifact.jobId) && artifact.jobId > 0)
      assert.ok(
        Number.isSafeInteger(artifact.attempt) &&
          artifact.attempt >= 1 &&
          artifact.attempt <= full.attempt,
      )
      assert.equal(artifact.name, `${source.kind}-${artifact.attempt}`)
      assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
      checkLinuxProof(proof, source.suites, { ...full, attempt: artifact.attempt })
    }
    return true
  } catch {
    return false
  }
}
