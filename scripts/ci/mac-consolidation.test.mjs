import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasMacCoverage } from '../full-proof.mjs'
import { checkNativeProof, nativePlan, selectedNative } from './mac-native-plan.mjs'
import { signingState, waitForSigning } from './mac-priority.mjs'
import { fixtureMacProof, fixtureWindowsProof } from './mac-proof-fixture.mjs'

const context = { repository: 'test/litch', sha: 'a'.repeat(40), runId: 42, attempt: 2 }
const run = {
  id: 42,
  repository: { full_name: context.repository },
  head_sha: context.sha,
  run_attempt: 2,
  path: '.github/workflows/release.yml',
  event: 'workflow_dispatch',
  status: 'in_progress',
}
const job = {
  id: 123,
  name: 'desktop-macos',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  completed_at: '2026-11-03T00:00:00Z',
}

test('签名完成前只等待；错SHA/run/attempt、失败/取消或其他workflow均不放行Mac', () => {
  assert.equal(signingState(run, [], context), null)
  assert.equal(
    signingState(
      { ...run, status: 'queued' },
      [{ ...job, status: 'in_progress', conclusion: null }],
      context,
    ),
    null,
  )
  assert.throws(() =>
    signingState(
      { ...run, status: 'completed' },
      [{ ...job, status: 'in_progress', conclusion: null }],
      context,
    ),
  )
  assert.equal(signingState(run, [{ ...job, status: 'queued', conclusion: null }], context), null)
  assert.equal(signingState(run, [job], context).job, 123)
  for (const changed of [
    { ...run, head_sha: 'b'.repeat(40) },
    { ...run, id: 43 },
    { ...run, run_attempt: 3 },
    { ...run, path: '.github/workflows/full.yml' },
  ])
    assert.throws(() => signingState(changed, [job], context))
  for (const conclusion of ['failure', 'cancelled', 'skipped'])
    assert.throws(() => signingState(run, [{ ...job, conclusion }], context))
  assert.throws(() => signingState(run, [job, job], context))
})

test('等待有界，不重跑签名或产品检查；完成后才返回', async () => {
  let time = 0
  let requests = 0
  const options = {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    readRun: () => run,
    readJobs: () => {
      requests++
      return requests === 2 ? [job] : []
    },
    limitMs: 60_000,
  }
  assert.equal((await waitForSigning(context, options)).job, 123)
  assert.equal(requests, 2)
  await assert.rejects(waitForSigning(context, { ...options, readJobs: () => [] }), /超过70分钟/)
})

test('合并保留窗口检查与原生CU；浏览器按CI覆盖，手机/未知域不能混入Mac', () => {
  assert.equal(nativePlan(['client']).checks.length, 27)
  assert.ok(nativePlan(['client']).checks.some((check) => check.id === 'client:user-bubble'))
  assert.equal(nativePlan(['computer-use']).checks.length, 3)
  assert.deepEqual(
    nativePlan(['client-engines']).checks.map((x) => x.id),
    ['client-engines:fixture', 'client-engines:windows'],
  )
  assert.deepEqual(selectedNative('["mobile"]', false), ['ios'])
  assert.deepEqual(selectedNative('["mobile"]', true), ['browser', 'ios'])
  assert.throws(() => nativePlan(['mobile']))
  assert.throws(() => nativePlan(['client', 'client']))
})

test('汇总不能用一个成功job冒充Mac覆盖；逐检查和artifact来源缺一项就拒绝', () => {
  const full = {
    ...context,
    workflowSha: context.sha,
    domains: '',
    runCi: true,
    jobs: { native: 'success' },
  }
  full.macProof = fixtureMacProof(full)
  assert.equal(hasMacCoverage(full), true)
  checkNativeProof(full.macProof.proof, selectedNative('', true), full)
  for (const alter of [
    (p) => {
      p.macProof = null
    },
    (p) => {
      p.macProof.proof.results.pop()
    },
    (p) => {
      p.macProof.proof.results[0].code = 1
    },
    (p) => {
      p.macProof.proof.results[0].signal = 'SIGTERM'
    },
    (p) => {
      p.macProof.proof.complete = false
    },
    (p) => {
      p.macProof.proof.sha = 'b'.repeat(40)
    },
    (p) => {
      p.macProof.proof.attempt = 1
    },
    (p) => {
      p.macProof.artifact.attempt = 3
    },
    (p) => {
      p.macProof.artifact.name = 'another'
    },
    (p) => {
      p.macProof.artifact.digest = ''
    },
    (p) => {
      p.macProof.artifact.jobId = 0
    },
    (p) => {
      p.macProof.proof.plan.checks[0].command = ['true']
    },
  ]) {
    const changed = structuredClone(full)
    alter(changed)
    assert.equal(hasMacCoverage(changed), false)
  }
})

test('复用Linux首回合必须绑定artifact及稳定ID：缺失或对不上不能算Full完整', async () => {
  const { fixtureLinuxProofs } = await import('./mac-proof-fixture.mjs')
  const { hasLinuxCoverage } = await import('./linux-proof.mjs')
  const { fullJobs, hasReleaseCoverage } = await import('../full-proof.mjs')
  const full = {
    ...context,
    schema: 1,
    workflowSha: context.sha,
    domains: '',
    runCi: true,
    jobs: Object.fromEntries(fullJobs.map((job) => [job, 'success'])),
  }
  full.macProof = fixtureMacProof(full)
  full.linuxProofs = fixtureLinuxProofs(full)
  full.windowsProof = fixtureWindowsProof(full)
  assert.equal(hasReleaseCoverage(full), true)
  const key = 'linux-checks-ci-client'
  for (const alter of [
    (p) => {
      delete p.linuxProofs
    },
    (p) => {
      delete p.linuxProofs[key]
    },
    (p) => {
      p.linuxProofs[key].artifact.id = 0
    },
    (p) => {
      p.linuxProofs[key].artifact.digest = 'wrong'
    },
    (p) => {
      p.linuxProofs[key].artifact.name = 'linux-checks-real-engines-2'
    },
    (p) => {
      p.linuxProofs[key].artifact.attempt = 3
    },
    (p) => {
      p.linuxProofs[key].proof.sha = 'b'.repeat(40)
    },
    (p) => {
      p.linuxProofs[key].proof.runId = '43'
    },
    (p) => {
      p.linuxProofs[key].proof.attempt = 1
    },
    (p) => {
      p.linuxProofs[key].proof.results = p.linuxProofs[key].proof.results.filter(
        (x) => x.id !== 'first-turn',
      )
    },
    (p) => {
      p.linuxProofs[key].proof.results[0].code = 1
    },
    (p) => {
      p.linuxProofs[key].proof.results[0].tests.skipped = 1
    },
    (p) => {
      p.linuxProofs[key].proof.plan.checks[0].command = ['true']
    },
    (p) => {
      p.linuxProofs[key].proof.clis = []
    },
    (p) => {
      p.linuxProofs[key].proof.complete = false
    },
  ]) {
    const changed = structuredClone(full)
    alter(changed)
    assert.equal(hasLinuxCoverage(changed), false)
    assert.equal(hasReleaseCoverage(changed), false)
  }
})

test('签名一直queued或执行不结束，聚合状态queued也须在固定预算内报错', async () => {
  for (const status of ['queued', 'in_progress']) {
    let time = 0
    let reads = 0
    await assert.rejects(
      waitForSigning(context, {
        now: () => time,
        limitMs: 30_000,
        sleep: async (ms) => {
          time += ms
        },
        readRun: () => ({ ...run, status: 'queued' }),
        readJobs: () => {
          reads++
          return [{ ...job, status, conclusion: null }]
        },
      }),
      /等待候选签名超过70分钟/,
    )
    assert.equal(time, 30_000)
    assert.equal(reads, 2)
  }
})
