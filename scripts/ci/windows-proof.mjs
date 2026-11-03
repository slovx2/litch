// Windows 原生集合必须来自同 run 的真实成功作业；Linux 的通过不能替代。
import assert from 'node:assert/strict'
import { checkExecutionProof } from './check-proof.mjs'

export const windowsSource = {
  kind: 'windows-native-proof',
  job: 'gate / windows / windows',
  suites: ['windows-native'],
}

export const checkWindowsProof = (proof, context) =>
  checkExecutionProof(proof, windowsSource.suites, context, 'win32')

export function hasWindowsCoverage(full) {
  try {
    if (!full.runCi) return full.windowsProof === null
    assert.equal(full.jobs.gate, 'success')
    const { artifact, proof } = full.windowsProof
    assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0)
    assert.ok(Number.isSafeInteger(artifact.jobId) && artifact.jobId > 0)
    assert.ok(
      Number.isSafeInteger(artifact.attempt) &&
        artifact.attempt >= 1 &&
        artifact.attempt <= full.attempt,
    )
    assert.equal(artifact.name, `${windowsSource.kind}-${artifact.attempt}`)
    assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
    checkWindowsProof(proof, { ...full, attempt: artifact.attempt })
    return true
  } catch {
    return false
  }
}
