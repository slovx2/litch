// 只供证明策略单测构造数据；不是实跑证据，不能上传用于发版。
import { nativeCliVersions, nativePlan, selectedNative } from './mac-native-plan.mjs'

export function fixtureMacProof(full) {
  const plan = nativePlan(selectedNative(full.domains, full.runCi))
  return {
    artifact: {
      id: 987,
      jobId: 654,
      attempt: full.attempt,
      name: `mac-native-proof-${full.attempt}`,
      digest: `sha256:${'a'.repeat(64)}`,
    },
    proof: {
      schema: 1,
      repository: full.repository,
      sha: full.sha,
      workflowSha: full.workflowSha,
      runId: full.runId,
      attempt: full.attempt,
      platform: 'darwin',
      arch: 'arm64',
      complete: true,
      plan,
      clis: nativeCliVersions(plan.domains),
      results: plan.checks.map(({ id }) => ({ id, code: 0, signal: null })),
    },
  }
}
