// Full复用CI首回合必须带真实检查制品，不能只用调用job的success代替检查身份。
import assert from 'node:assert/strict'
import { domains as fullDomains } from '../ci-impact.mjs'
import { checkExecutionProof } from './check-proof.mjs'

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

export const checkLinuxProof = (proof, names, context) =>
  checkExecutionProof(proof, names, context, 'linux')

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
