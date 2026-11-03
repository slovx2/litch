// Linux演练与真实API之前的替身验收；不连接GitHub，不执行产品测试。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkControllerRun, recoverRun } from './recovery-controller.mjs'
import { buildRecoveryGraph } from './recovery-graph.mjs'
import { loadLedger } from './recovery-ledger.mjs'
import { controllerPlan, fixtureStep, fixtureWorkflow } from './recovery-plan.mjs'
import { githubWriter } from './recovery-write.mjs'

const sha = 'a'.repeat(40)
const ended = Date.parse('2026-11-03T03:00:00Z')
const now = () => ended + 1000
const readWorkflow = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const controller = { runId: 500, sha, attempt: 1, rehearsal: true, defaultBranch: 'main' }
const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' }
const artifact = {
  id: 77,
  name: 'recovery-fixture-preserved',
  digest: `sha256:${'b'.repeat(64)}`,
  expired: false,
}
function fixture(scenario = 'infra', second = false) {
  let id = 1000
  const step = (name, conclusion, number = 1) => ({
    name,
    number,
    conclusion,
    status: 'completed',
    started_at: new Date(ended - 10_000).toISOString(),
    completed_at: new Date(ended - 5000).toISOString(),
  })
  const job = (name, conclusion, steps = []) => ({
    id: ++id,
    name,
    conclusion,
    status: 'completed',
    head_sha: sha,
    run_id: 100,
    run_attempt: second ? 2 : 1,
    runner_name: conclusion === 'skipped' ? '' : 'linux-test',
    runner_id: conclusion === 'skipped' ? 0 : 10,
    labels: ['ubuntu-24.04'],
    steps,
    started_at: new Date(ended - 20_000).toISOString(),
    completed_at: new Date(ended).toISOString(),
  })
  const infra = (name, active) =>
    job(
      name,
      active ? (second ? 'success' : 'failure') : 'skipped',
      active
        ? [
            step('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'success'),
            step(fixtureStep, second ? 'success' : 'failure', 2),
          ]
        : [],
    )
  const jobs = [
    infra('infra-a', scenario !== 'product'),
    infra('infra-b', scenario === 'multi'),
    job(
      'product',
      ['product', 'mixed'].includes(scenario) ? 'failure' : 'skipped',
      ['product', 'mixed'].includes(scenario) ? [step('合成产品断言（禁止重试）', 'failure')] : [],
    ),
    job('preserved', 'success', [step('build preserved bytes', 'success')]),
    job(second ? 'downstream / verify' : 'downstream', second ? 'success' : 'skipped'),
    job('report', second ? 'success' : 'failure', [
      step('阻断失败的上游', second ? 'skipped' : 'failure'),
      step('Run echo report', second ? 'success' : 'skipped', 2),
    ]),
  ]
  const evidence = Object.fromEntries(
    jobs
      .filter((j) => j.conclusion === 'failure')
      .map((j) => [
        j.id,
        {
          stepLog: {
            complete: true,
            number: j.steps.find((s) => s.conclusion === 'failure').number,
            text:
              j.name === 'report'
                ? '##[error]LITCH_RECOVERY_UPSTREAM_FAILURE\n##[error]Process completed with exit code 1.'
                : j.name === 'product'
                  ? '##[error]AssertionError'
                  : '##[error]HTTP 503 LITCH_FIXTURE_INFRA\n##[error]Process completed with exit code 1.',
          },
        },
      ]),
  )
  return {
    run: {
      id: 100,
      head_sha: sha,
      run_attempt: second ? 2 : 1,
      head_branch: 'ci/recovery-nightly',
      repository: { full_name: 'slovx2/litch' },
      head_repository: { full_name: 'slovx2/litch' },
      path: fixtureWorkflow,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: second ? 'success' : 'failure',
      created_at: new Date(ended - 60_000).toISOString(),
      updated_at: new Date(ended).toISOString(),
    },
    jobs,
    evidence,
    activeMac: [],
    sourceBinding: { matched: true, sha, trustedSha: sha, digest: 'c'.repeat(64), rehearsal: true },
  }
}
function memory(scenario = 'infra') {
  const snapshot = fixture(scenario)
  const machine = {
    snapshot,
    issues: [],
    comments: [],
    calls: [],
    history: [],
    artifacts: [artifact],
    failWrite: false,
    timeout: false,
  }
  const controlRun = {
    id: 500,
    head_sha: sha,
    run_attempt: 1,
    event: 'workflow_dispatch',
    path: '.github/workflows/recovery-controller.yml',
    head_branch: 'ci/recovery-nightly',
    repository: snapshot.run.repository,
    head_repository: snapshot.run.head_repository,
    created_at: new Date(ended + 500).toISOString(),
  }
  const read = (path) => {
    if (path === 'repos/slovx2/litch/actions/runs/100') return structuredClone(machine.snapshot.run)
    if (path === 'repos/slovx2/litch/actions/runs/500') return controlRun
    if (path.includes('/issues?')) return machine.issues
    if (path.includes('/issues/9/comments')) return machine.comments
    if (path.includes('/artifacts?')) return { artifacts: machine.artifacts }
    if (path.includes('/attempts/2/jobs?')) return { jobs: machine.snapshot.jobs }
    if (path.includes('/workflows/recovery-controller.yml/runs?'))
      return { workflow_runs: machine.history }
    throw new Error(`未预期读取：${path}`)
  }
  const write = (path, body) => {
    machine.calls.push({ path, body })
    if (machine.failWrite) throw new Error('写入失败')
    const record = {
      id: 10 + machine.calls.length,
      user: bot,
      created_at: new Date(now()).toISOString(),
      ...body,
    }
    if (path.endsWith('/issues')) machine.issues.push({ ...record, number: 9 })
    else if (path.endsWith('/comments')) machine.comments.push(record)
    else if (path.endsWith('/rerun-failed-jobs') || path.endsWith('/rerun')) {
      machine.snapshot = fixture(scenario, true)
      machine.snapshot.run.status = 'in_progress'
      machine.snapshot.run.conclusion = null
      if (machine.timeout) throw new Error('请求结果丢失')
    } else throw new Error('未允许的写入')
    return record
  }
  machine.services = {
    read,
    write,
    observe: () => ({ snapshot: structuredClone(machine.snapshot), stable: true }),
    readWorkflow,
    controller,
    now,
    enabled: true,
  }
  machine.apiCalls = () =>
    machine.calls.filter((call) => /\/rerun(?:-failed-jobs)?$/.test(call.path))
  return machine
}

test('真实fixture YAML展开可复用下游；单根/多根只恢复根和必要汇总', () => {
  for (const scenario of ['infra', 'multi']) {
    const snapshot = fixture(scenario)
    const plan = controllerPlan(snapshot, readWorkflow, { rehearsal: true, now: now() })
    assert.equal(plan.decision, 'eligible')
    assert.equal(plan.dependencyClosureVerified, true)
    assert.equal(plan.request.kind, 'failed-jobs') // report是独立终态的派生失败
    assert.ok(plan.closure.some((node) => node.name === 'downstream / verify'))
    assert.ok(!plan.closure.some((node) => node.name === 'preserved'))
    assert.equal(plan.roots.length, scenario === 'multi' ? 2 : 1)
  }
})

test('产品或混合失败不预占预算、不调用API；合成例外不适用于正式profile', () => {
  for (const scenario of ['product', 'mixed']) {
    const machine = memory(scenario)
    assert.equal(recoverRun(100, machine.services).state, 'blocked')
    assert.equal(machine.calls.length, 0)
  }
  assert.equal(controllerPlan(fixture(), readWorkflow, { now: now() }).decision, 'blocked')
})

test('上游失败必须有独立明确标记；unknown proof错误不因上游infra而忽略', () => {
  const snapshot = fixture()
  snapshot.evidence[snapshot.jobs.at(-1).id].stepLog.text = 'artifact digest mismatch'
  assert.equal(
    controllerPlan(snapshot, readWorkflow, { rehearsal: true, now: now() }).decision,
    'blocked',
  )
})

test('完整成功片落入重跑闭包时拒绝；Mac竞争不占用恢复预算', () => {
  const snapshot = fixture()
  snapshot.jobs[4] = { ...snapshot.jobs[4], name: 'downstream / verify', conclusion: 'success' }
  assert.equal(
    controllerPlan(snapshot, readWorkflow, { rehearsal: true, now: now() }).reason,
    'would-repeat-successful-work',
  )
  const other = fixture()
  other.jobs[0].labels = ['macos-15']
  other.activeMac = [{ runId: 900 }]
  assert.equal(
    controllerPlan(other, readWorkflow, { rehearsal: true, now: now() }).decision,
    'deferred',
  )
})

test('DAG拒绝未知job、动态矩阵、调用环及新外部workflow，不执行表达式', () => {
  const cases = [
    'jobs:\n  x:\n    runs-on: ubuntu-24.04\n    strategy:\n      matrix: "${{ fromJSON(inputs.matrix) }}"',
    'jobs:\n  x:\n    uses: other/repo/.github/workflows/a.yml@main',
    'jobs:\n  x:\n    uses: ./.github/workflows/ci.yml',
    'jobs:\n  x:\n    runs-on: ubuntu-24.04\n    needs: y\n  y:\n    runs-on: ubuntu-24.04\n    needs: x',
  ]
  for (const yaml of cases)
    assert.throws(() => buildRecoveryGraph('.github/workflows/ci.yml', [], () => yaml))
  assert.throws(() =>
    buildRecoveryGraph(fixtureWorkflow, [{ name: 'unknown', conclusion: 'success' }], readWorkflow),
  )
})

test('先写入并读回reservation再调用一次API，重复控制器只对账', () => {
  const machine = memory()
  assert.equal(recoverRun(100, machine.services).state, 'recovery-running')
  assert.equal(machine.calls[0].path, 'repos/slovx2/litch/issues')
  assert.equal(machine.apiCalls().length, 1)
  assert.ok(machine.issues[0].body.includes('reservation'))
  assert.equal(recoverRun(100, machine.services).state, 'recovery-running')
  assert.equal(machine.apiCalls().length, 1)
  machine.snapshot.run.status = 'completed'
  machine.snapshot.run.conclusion = 'success'
  assert.equal(recoverRun(100, machine.services).state, 'recovery-completed')
  assert.equal(recoverRun(100, machine.services).state, 'already-resolved')
  assert.equal(machine.apiCalls().length, 1)
})

test('reservation写失败不调用API；API响应丢失只读核实，不再次POST', () => {
  const failed = memory()
  failed.failWrite = true
  assert.throws(() => recoverRun(100, failed.services))
  assert.equal(failed.apiCalls().length, 0)
  const uncertain = memory()
  uncertain.timeout = true
  assert.equal(recoverRun(100, uncertain.services).state, 'api-result-uncertain')
  assert.equal(recoverRun(100, uncertain.services).state, 'recovery-running')
  assert.equal(uncertain.apiCalls().length, 1)
})

test('写前复查发现新失败/attempt改变，reservation保留但不调用重跑', () => {
  const machine = memory()
  let calls = 0
  machine.services.observe = () => {
    calls++
    const snapshot = fixture()
    if (calls === 2) snapshot.run.run_attempt = 2
    return { snapshot, stable: true }
  }
  assert.equal(recoverRun(100, machine.services).state, 'aborted')
  assert.equal(machine.apiCalls().length, 0)
  assert.equal(loadLedger(machine.services.read, { runId: 100, sha }).reserved, true)
})

test('写入reservation后读不到原记录，禁止调用API', () => {
  const machine = memory()
  const read = machine.services.read
  let lists = 0
  machine.services.read = (path) => {
    if (path.includes('/issues?') && ++lists >= 3) return []
    return read(path)
  }
  assert.throws(() => recoverRun(100, machine.services), /可靠写入/)
  assert.equal(machine.apiCalls().length, 0)
})

test('未知/伪造审计作者、重复issue、删除后的控制器痕迹都不能重置预算', () => {
  const machine = memory()
  recoverRun(100, machine.services)
  const good = structuredClone(machine.issues[0])
  machine.issues[0].user = { ...bot, id: 1 }
  assert.throws(() => recoverRun(100, machine.services), /作者/)
  machine.issues = [good, { ...good, number: 10 }]
  assert.throws(() => recoverRun(100, machine.services), /不唯一/)
  const deleted = memory()
  deleted.history = [
    {
      id: 499,
      updated_at: new Date(now()).toISOString(),
      display_title: 'CI recovery 100 fixture-recover',
    },
  ]
  assert.equal(recoverRun(100, deleted.services).reason, 'ledger-missing-after-prior-controller')
  assert.equal(deleted.apiCalls().length, 0)
})

test('人工关闭审计issue不释放预算；无机器标记的普通评论不改变链', () => {
  const machine = memory()
  recoverRun(100, machine.services)
  machine.issues[0].state = 'closed'
  machine.comments.push({
    body: '人工说明',
    user: { id: 1 },
    created_at: new Date(now()).toISOString(),
  })
  assert.equal(recoverRun(100, machine.services).state, 'recovery-running')
  assert.equal(machine.apiCalls().length, 1)
})

test('原成功片被重做、制品被删换及API范围超出计划都判验收失败', () => {
  for (const change of [
    (m) => {
      m.snapshot.jobs.find((j) => j.name === 'preserved').started_at = new Date(now()).toISOString()
    },
    (m) => {
      m.artifacts = [{ ...artifact, id: 78 }]
    },
    (m) => {
      m.artifacts = [{ ...artifact, digest: `sha256:${'c'.repeat(64)}` }]
    },
    (m) => {
      m.snapshot.jobs.push({ ...m.snapshot.jobs[0], id: 2000, name: 'unexpected' })
    },
    (m) => {
      m.snapshot.jobs[0].head_sha = 'c'.repeat(40)
    },
  ]) {
    const machine = memory()
    recoverRun(100, machine.services)
    machine.snapshot.run.status = 'completed'
    machine.snapshot.run.conclusion = 'success'
    change(machine)
    assert.equal(recoverRun(100, machine.services).state, 'recovery-verification-failed')
    assert.equal(machine.apiCalls().length, 1)
  }
})

test('恢复后产品仍失败，只记录真实失败、不发第三attempt', () => {
  const machine = memory()
  recoverRun(100, machine.services)
  machine.snapshot.run.status = 'completed'
  machine.snapshot.run.conclusion = 'failure'
  machine.snapshot.jobs.find((j) => j.name === 'downstream / verify').conclusion = 'failure'
  const result = recoverRun(100, machine.services)
  assert.equal(result.conclusion, 'failure')
  assert.equal(machine.apiCalls().length, 1)
  assert.equal(
    loadLedger(machine.services.read, { runId: 100, sha }).last.details.conclusion,
    'failure',
  )
})

test('Mac竞争deferred不预占，2小时后不再恢复', () => {
  const machine = memory()
  machine.snapshot.jobs[0].labels = ['macos-15']
  machine.snapshot.activeMac = [{ runId: 900 }]
  assert.equal(recoverRun(100, machine.services).state, 'deferred')
  assert.equal(loadLedger(machine.services.read, { runId: 100, sha }).reserved, false)
  assert.equal(machine.apiCalls().length, 0)
  machine.services.now = () => ended + 2 * 60 * 60_000
  assert.equal(recoverRun(100, machine.services).reason, 'recovery-window-expired')
  assert.equal(machine.apiCalls().length, 0)
})

test('控制器默认关闭及身份限制；写接口不提供通用变更或发布权限', () => {
  const machine = memory()
  assert.equal(recoverRun(100, { ...machine.services, enabled: false }).state, 'observe-only')
  assert.equal(machine.calls.length, 0)
  const run = machine.services.read('repos/slovx2/litch/actions/runs/500')
  checkControllerRun(run, controller)
  for (const changed of [
    { ...run, head_sha: 'b'.repeat(40) },
    { ...run, run_attempt: 2 },
    { ...run, path: '.github/workflows/ci.yml' },
    { ...run, head_branch: 'evil' },
  ])
    assert.throws(() => checkControllerRun(changed, controller))
  let called = false
  const write = githubWriter((_cmd, args) => {
    called = true
    assert.equal(args[2], 'POST')
    return 'HTTP/2.0 201 Created\r\n\r\n{}'
  })
  for (const path of ['releases', 'git/refs', 'actions/runs/100/cancel'])
    assert.throws(() => write(`repos/slovx2/litch/${path}`))
  assert.equal(called, false)
  write('repos/slovx2/litch/actions/jobs/1/rerun')
  assert.equal(called, true)
})

test('正式CI/Full/Gate/Prepare所有当前工作流均可解析，带签名协调的额外依赖单列', () => {
  for (const name of ['ci', 'full', 'gate', 'release', 'windows']) {
    const graph = buildRecoveryGraph(`.github/workflows/${name}.yml`, [], readWorkflow)
    assert.ok(graph.nodes.length > 0)
    if (name === 'release') {
      const waits = graph.nodes.filter((node) => node.apiWait)
      assert.equal(waits.length, 2)
      assert.ok(waits.every((node) => node.ancestors.includes('desktop-macos')))
    }
  }
})

test('真实compare端点的三点语法不能被目录穿越守卫误拒绝', async () => {
  const { githubReader } = await import('./recovery-observe.mjs')
  const read = githubReader(() => JSON.stringify({ status: 'identical' }))
  assert.equal(read(`repos/slovx2/litch/compare/${sha}...${sha}`).status, 'identical')
  assert.throws(() => read(`repos/slovx2/litch/compare/${sha}...../../secret`))
})

test('控制器与fixture权限和开关接线固定，不给只读入口写权限', () => {
  const file = readWorkflow('.github/workflows/recovery-controller.yml')
  const observe = file.slice(file.indexOf('  observe:'), file.indexOf('  recovery:'))
  assert.ok(!observe.includes('actions: write'))
  assert.ok(!observe.includes('issues: write'))
  assert.match(file, /vars\.LITCH_CI_RECOVERY_ENABLED == 'true'/)
  assert.match(file, /cancel-in-progress: false/)
  assert.match(file, /persist-credentials: false/)
  assert.ok(!file.includes('contents: write'))
  const fixtureFile = readWorkflow(fixtureWorkflow)
  assert.ok(!fixtureFile.includes('macos'))
  assert.ok(!fixtureFile.includes('secrets.'))
  assert.ok(!fixtureFile.includes('contents: write'))
})

test('准备步骤还要绑定YAML里的真实uses，不能借同名run脚本重跑产品', () => {
  const snapshot = fixture()
  snapshot.run.path = '.github/workflows/ci.yml'
  snapshot.run.head_branch = 'main'
  const job = snapshot.jobs[0]
  job.name = 'unit'
  const action = 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
  job.steps = [
    { number: 1, name: 'Set up job', conclusion: 'success' },
    { number: 2, name: `Run ${action}`, conclusion: 'failure' },
  ]
  snapshot.jobs = [job]
  snapshot.evidence = {
    [job.id]: { stepLog: { number: 2, complete: true, text: '##[error]HTTP 503' } },
  }
  const prefix = 'jobs:\n  unit:\n    runs-on: ubuntu-24.04\n    steps:\n'
  const fake = `${prefix}      - name: Run ${action}\n        run: npm test\n`
  assert.equal(controllerPlan(snapshot, () => fake, { now: now() }).decision, 'blocked')
  const real = `${prefix}      - uses: ${action}\n`
  assert.equal(controllerPlan(snapshot, () => real, { now: now() }).decision, 'eligible')
})

test('只缓存完整SHA的不可变源码，不缓存可变run/分支与恢复预算', async () => {
  const { githubReader } = await import('./recovery-observe.mjs')
  let calls = 0
  const read = githubReader(() => {
    calls++
    return JSON.stringify({ number: calls })
  })
  const file = `repos/slovx2/litch/contents/package.json?ref=${sha}`
  read(file).number = -1
  assert.equal(read(file).number, 1)
  assert.equal(calls, 1)
  read('repos/slovx2/litch/actions/runs/100')
  read('repos/slovx2/litch/actions/runs/100')
  read('repos/slovx2/litch/commits/main')
  read('repos/slovx2/litch/commits/main')
  assert.equal(calls, 5)
})
