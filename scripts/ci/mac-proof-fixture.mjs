// 只供证明策略单测构造数据；不是实跑证据，不能上传用于发版。

import { readFileSync } from 'node:fs'
import { checkPlan, expectsNodeTests } from './check-catalog.mjs'
import { cliPackages } from './install-test-clis.mjs'
import { linuxSources } from './linux-proof.mjs'
import { nativeCliVersions, nativePlan, selectedNative } from './mac-native-plan.mjs'

export function fixtureLinuxProofs(full) {
  const versions = JSON.parse(
    readFileSync(new URL('../../protocol/versions.json', import.meta.url)),
  )
  const specs = cliPackages(versions)
  return Object.fromEntries(
    linuxSources(full.domains, full.runCi).map((source, index) => {
      const plan = checkPlan(source.suites)
      return [
        source.kind,
        {
          artifact: {
            id: 1000 + index,
            jobId: 2000 + index,
            attempt: full.attempt,
            name: `${source.kind}-${full.attempt}`,
            digest: `sha256:${'b'.repeat(64)}`,
          },
          proof: {
            schema: 1,
            repository: full.repository,
            sha: full.sha,
            runId: String(full.runId),
            attempt: full.attempt,
            platform: 'linux',
            arch: 'x64',
            node: 'v24.21.0',
            complete: true,
            versions,
            plan,
            clis: plan.clis.map((id) => ({
              id,
              package: specs[id].name,
              version: specs[id].version,
            })),
            results: plan.checks.map(({ id }) => ({
              id,
              code: 0,
              signal: null,
              tests: {
                tests: expectsNodeTests(id) ? 1 : 0,
                fail: 0,
                cancelled: 0,
                skipped: 0,
                names: expectsNodeTests(id) ? ['fixture'] : [],
              },
            })),
          },
        },
      ]
    }),
  )
}

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
