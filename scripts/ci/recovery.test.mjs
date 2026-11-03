// 合成故障只验证恢复分类与账本，不启动runner、不触发workflow。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { auditRecord, observation, readAudit } from './recovery-audit.mjs'
import { readStepLog, stepLogPath } from './recovery-evidence.mjs'
import {
  bindSource,
  githubReader,
  observeRun,
  readPages,
  recoverySummary,
} from './recovery-observe.mjs'
import { evidenceHash, planRecovery, recoveryWindowMs } from './recovery-policy.mjs'

const sha = 'a'.repeat(40)
const completed = Date.parse('2026-11-03T03:00:00Z')
const checkout = 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const setup = 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'
const platformMessage =
  'The job was not acquired by Runner of type hosted even after multiple attempts'
function step(number, name, conclusion = 'success') {
  return { number, name, status: 'completed', conclusion }
}
function sample() {
  const run = {
    id: 100,
    head_sha: sha,
    run_attempt: 1,
    head_branch: 'main',
    repository: { full_name: 'slovx2/litch' },
    head_repository: { full_name: 'slovx2/litch' },
    path: '.github/workflows/full.yml',
    event: 'schedule',
    status: 'completed',
    conclusion: 'failure',
    updated_at: new Date(completed).toISOString(),
  }
  const job = {
    id: 200,
    name: 'dsh',
    run_id: 100,
    run_attempt: 1,
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
    runner_name: 'hosted-1',
    runner_id: 3,
    labels: ['ubuntu-24.04'],
    steps: [step(1, 'Set up job'), step(2, checkout), step(3, setup, 'failure')],
  }
  return {
    run,
    jobs: [job],
    sourceBinding: { matched: true, sha, trustedSha: sha, digest: 'b'.repeat(64) },
    evidence: {
      200: { stepLog: { number: 3, complete: true, text: '##[error]download failed: ECONNRESET' } },
    },
    activeMac: [],
  }
}
const plan = (value = sample(), options = {}) =>
  planRecovery(value, { now: completed + 1000, ...options })

test('固定准备步骤的网络首败可分类，但第一笔永远只读且不能reservation', () => {
  const result = plan()
  assert.equal(result.decision, 'eligible')
  assert.equal(result.automatic, false)
  assert.equal(result.mode, 'observe')
  assert.equal(result.dependencyClosureVerified, false)
  assert.equal(result.jobs[0].reason, 'preparation-node-network')
  assert.equal(result.jobs[0].evidenceHash, evidenceHash('##[error]download failed: ECONNRESET'))
  assert.throws(() => auditRecord(result, 'reservation', {}, null, completed + 1000), /下游/)
})

test('产品断言、混合故障、含网络文字的测试超时都不恢复', () => {
  for (const name of [
    'Run npm test',
    'Run npm run build',
    'CDP ETIMEDOUT',
    'Run npm ci --no-audit --no-fund',
  ]) {
    const value = sample()
    value.jobs[0].steps[2].name = name
    assert.equal(plan(value).decision, 'blocked', name)
  }
  const value = sample()
  value.jobs.push({
    ...value.jobs[0],
    id: 201,
    name: 'unit',
    steps: [step(1, 'Run npm test', 'failure')],
  })
  assert.equal(plan(value).reason, 'product-unknown-or-mixed-failure')
})

test('不根据容量notice或空runner推断可恢复；明确平台首败才可分类', () => {
  const value = sample()
  const job = value.jobs[0]
  Object.assign(job, { steps: [], runner_name: '', runner_id: 0, conclusion: 'cancelled' })
  value.evidence[200] = {
    annotations: [{ annotation_level: 'notice', message: 'Due to capacity constraints' }],
  }
  assert.equal(plan(value).decision, 'blocked')
  value.evidence[200].annotations.push({ annotation_level: 'failure', message: platformMessage })
  assert.equal(plan(value).decision, 'eligible')
  value.run.conclusion = 'cancelled'
  assert.equal(plan(value).reason, 'run-not-failure')
  value.run.conclusion = 'failure'
  job.runner_name = 'actually-ran'
  assert.equal(plan(value).decision, 'blocked')
})

test('不存在精确步骤日志、日志截断、错步骤号和其他错误都拒绝', () => {
  for (const log of [
    null,
    { number: 3, complete: false, text: 'ECONNRESET' },
    { number: 4, complete: true, text: 'ECONNRESET' },
  ]) {
    const value = sample()
    value.evidence[200].stepLog = log
    assert.equal(plan(value).decision, 'blocked')
  }
  for (const text of [
    'ETIMEDOUT Permission denied',
    'ECONNRESET checksum mismatch',
    'HTTP 403',
    'HTTP 429',
    'HTTP 503 attempts exhausted',
    'random error',
  ]) {
    const value = sample()
    value.evidence[200].stepLog.text = text
    assert.equal(plan(value).decision, 'blocked', text)
  }
})

test('安装或测试之后的准备故障、第二失败以及continue-on-error后继续工作都拒绝', () => {
  for (const before of [
    'Run npm test',
    'Run npm ci',
    '签名',
    '准备 Android SDK（仅下载基础设施重试）',
  ]) {
    const value = sample()
    value.jobs[0].steps[1].name = before
    assert.equal(plan(value).decision, 'blocked')
  }
  for (const after of [
    step(4, 'Post cache', 'failure'),
    step(4, 'Run npm test'),
    step(4, 'Run npm test', 'cancelled'),
  ]) {
    const value = sample()
    value.jobs[0].steps.push(after)
    assert.equal(plan(value).decision, 'blocked')
  }
  const value = sample()
  value.jobs[0].steps.push(step(4, 'Post checkout'))
  assert.equal(plan(value).decision, 'eligible')
})

test('手机已有预算、公证Rejected及票据耗尽不叠加恢复', () => {
  for (const name of ['mobile (2)', 'gate / tests / mobile (1)', 'mobile-build']) {
    const value = sample()
    value.jobs[0].name = name
    assert.equal(plan(value).jobs[0].kind, 'excluded')
  }
  for (const name of ['签名并公证到 Accepted 检查点', '恢复 Accepted 包并钉票校验（不重新公证）']) {
    const value = sample()
    value.jobs[0].steps[2].name = name
    value.evidence[200].stepLog.text = 'Rejected NSURLErrorDomain -1005 Error 68'
    assert.equal(plan(value).decision, 'blocked')
  }
})

test('来源仓库、SHA、attempt、重复逻辑片、契约变化和人工重跑不越界', () => {
  const mutations = [
    (v) => {
      v.run.head_repository.full_name = 'fork/litch'
    },
    (v) => {
      v.run.event = 'pull_request'
    },
    (v) => {
      v.run.path = '.github/workflows/promote.yml'
    },
    (v) => {
      v.run.run_attempt = 2
    },
    (v) => {
      v.sourceBinding.matched = false
    },
    (v) => {
      v.sourceBinding.sha = 'b'.repeat(40)
    },
    (v) => {
      v.jobs[0].head_sha = 'b'.repeat(40)
    },
    (v) => {
      v.jobs[0].run_id++
    },
    (v) => {
      v.jobs[0].run_attempt++
    },
    (v) => {
      v.jobs.push({ ...v.jobs[0], id: 201 })
    },
  ]
  for (const mutate of mutations) {
    const value = sample()
    mutate(value)
    assert.equal(plan(value).decision, 'blocked')
  }
  assert.equal(plan(sample(), { reserved: true }).reason, 'recovery-budget-unavailable')
})

test('源run未结束不处理；Mac竞争deferred到2小时为止，Linux不占Mac', () => {
  const value = sample()
  value.run.status = 'in_progress'
  assert.equal(plan(value).reason, 'source-run-not-completed')
  value.run.status = 'completed'
  value.activeMac = [{ runId: 900, jobId: 901, status: 'queued' }]
  assert.equal(plan(value).decision, 'eligible')
  value.jobs[0].labels = ['macos-15']
  assert.equal(plan(value).decision, 'deferred')
  assert.equal(plan(value, { now: completed + recoveryWindowMs }).reason, 'recovery-window-expired')
  assert.equal(plan(value, { now: completed - 1 }).reason, 'invalid-completion-clock')
})

test('多根只有全部明确infra才能标eligible，成功或skipped不冒充失败根', () => {
  const value = sample()
  value.jobs.push({ ...value.jobs[0], id: 201, name: 'opencode' })
  value.evidence[201] = structuredClone(value.evidence[200])
  assert.equal(plan(value).roots.length, 2)
  value.evidence[201] = {}
  assert.equal(plan(value).decision, 'blocked')
  value.jobs[1].conclusion = 'success'
  assert.equal(plan(value).roots.length, 1)
})

test('精确失败步骤日志：不存在/重名/空文件拒绝，不读相邻步骤', () => {
  const job = { name: 'gate / unit' }
  const failed = step(3, setup, 'failure')
  const path = stepLogPath(job, failed)
  assert.equal(path, `gate _ unit/3_${setup.replace('/', '_')}.txt`)
  const unpack = (cmd, args) => {
    assert.equal(cmd, 'python3')
    assert.equal(args[0], '-I')
    assert.equal(args.at(-1), path)
    return 'ETIMEDOUT'
  }
  assert.equal(readStepLog(Buffer.from('zip'), job, failed, unpack).text, 'ETIMEDOUT')
  assert.throws(() => readStepLog(Buffer.from('zip'), job, failed, () => ''), /为空/)
  assert.throws(() => readStepLog(Buffer.from('zip'), { name: '..' }, failed, unpack), /路径/)
})

test('真实ZIP精确读取步骤；重复、缺失、CRC损坏、空文本及解压超限均拒绝', () => {
  const job = { name: 'infra-a' }
  const failed = { number: 3, name: '恢复演练：模拟准备下载' }
  const path = stepLogPath(job, failed)
  const zip = (entries) =>
    execFileSync(
      'python3',
      [
        '-I',
        '-c',
        `
import io, json, sys, warnings, zipfile
warnings.simplefilter("ignore", UserWarning)
target: io.BytesIO = io.BytesIO()
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for name, text in json.load(sys.stdin):
        archive.writestr(name, text)
sys.stdout.buffer.write(target.getvalue())
`,
      ],
      { input: JSON.stringify(entries), maxBuffer: 8 * 1024 * 1024 },
    )
  const content = '##[error]HTTP 503 LITCH_FIXTURE_INFRA\n'
  const valid = zip([
    [path, content],
    ['other/3_other.txt', 'do not read'],
  ])
  assert.equal(readStepLog(valid, job, failed).text, content)
  for (const entries of [
    [['other.txt', content]],
    [
      [path, content],
      [path, content],
    ],
    [[path, '']],
    [[path, 'x'.repeat(4 * 1024 * 1024 + 1)]],
  ])
    assert.throws(() => readStepLog(zip(entries), job, failed), /ZIP|为空/)
  const corrupt = Buffer.from(valid)
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  assert.ok(central > 0)
  corrupt[central + 16] ^= 0xff
  assert.throws(() => readStepLog(corrupt, job, failed), /ZIP/)
  assert.throws(() => readStepLog(Buffer.from('not zip'), job, failed), /ZIP/)
})

test('GET客户端不能写API，分页超限不以截断数据放行', () => {
  let call
  const read = githubReader((command, args, options) => {
    call = { command, args, options }
    return '{}'
  })
  read('repos/slovx2/litch/actions/runs/100')
  assert.deepEqual(call.args.slice(0, 3), ['api', '--method', 'GET'])
  assert.equal(call.options.timeout, 30_000)
  assert.throws(() => read('https://evil.test/token'))
  assert.throws(() => read('repos/slovx2/litch/../elsewhere'))
  assert.throws(() => readPages(() => Array(100).fill({}), 'repos/slovx2/litch/issues'), /上限/)
})

test('真实GET客户端允许仓库元信息根路径，拒绝同名前缀和其他仓库', () => {
  const requests = []
  const read = githubReader((_command, args) => {
    requests.push(args)
    return JSON.stringify({ default_branch: 'main' })
  })
  assert.equal(read('repos/slovx2/litch').default_branch, 'main')
  assert.deepEqual(requests[0], [
    'api',
    '--method',
    'GET',
    '--allow-escape-sequences',
    'repos/slovx2/litch',
  ])
  for (const path of [
    'repos/slovx2/litch-other',
    'repos/slovx2/litch-other/actions/runs',
    'repos/other/litch',
    'repos/slovx2/litch/../other',
    'repos/slovx2/litch\n',
  ])
    assert.throws(() => read(path))
  assert.equal(requests.length, 1, '被拒绝的路径不能发出GET')
})

function sourceReader(value, files) {
  return (path) => {
    if (path === 'repos/slovx2/litch') return { default_branch: 'main' }
    if (path.endsWith('/commits/main')) return { sha }
    if (path.includes('/compare/')) return { status: 'identical' }
    if (path.includes('/contents/')) {
      const name = path.split('/contents/')[1].split('?')[0]
      return {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(files[name] ?? '').toString('base64'),
      }
    }
    if (path.endsWith('/actions/runs/100')) return value.run
    if (path.includes('/attempts/1/jobs')) return { jobs: value.jobs }
    if (path.includes('/actions/runs?status=')) return { workflow_runs: [] }
    if (path.endsWith('/check-runs/200'))
      return { id: 200, head_sha: sha, app: { slug: 'github-actions' } }
    if (path.includes('/check-runs/200/annotations'))
      return [{ annotation_level: 'failure', message: platformMessage }]
    throw new Error('未预期读取')
  }
}

test('绑定源run与默认分支工作流bytes；外部分支、分叉和文件不同拒绝', () => {
  const value = sample()
  const files = { '.github/workflows/full.yml': 'name: Full' }
  const contract = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, evidenceHash(v)]))
  const read = sourceReader(value, files)
  assert.equal(bindSource(read, value.run, contract).matched, true)
  files['.github/workflows/full.yml'] = 'modified'
  assert.equal(bindSource(read, value.run, contract).matched, false)
  value.run.head_branch = 'unreviewed'
  assert.equal(bindSource(read, value.run, contract).reason, 'not-default-branch-source')
  value.run.head_branch = 'main'
  assert.equal(
    bindSource(
      (path) => (path.includes('/compare/') ? { status: 'diverged' } : read(path)),
      value.run,
      contract,
    ).matched,
    false,
  )
})

test('只读观察完整回放容量首败；采样时attempt改变、Mac列表读取失败都拒绝', () => {
  const value = sample()
  Object.assign(value.jobs[0], {
    steps: [],
    runner_name: '',
    runner_id: 0,
    conclusion: 'cancelled',
  })
  const files = { '.github/workflows/full.yml': 'name: Full' }
  const contract = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, evidenceHash(v)]))
  const read = sourceReader(value, files)
  const result = observeRun(100, { read, contract, now: completed + 1000 })
  assert.equal(result.plan.decision, 'eligible')
  assert.equal(result.audit.type, 'observation')
  assert.match(recoverySummary(result), /未启用/)
  let count = 0
  const changed = (path) =>
    path.endsWith('/actions/runs/100') && ++count === 2
      ? { ...value.run, run_attempt: 2 }
      : read(path)
  assert.equal(
    observeRun(100, { read: changed, contract, now: completed + 1000 }).plan.reason,
    'source-changed-during-observation',
  )
  const unavailable = (path) => {
    if (path.includes('/actions/runs?')) throw new Error('API失效')
    return read(path)
  }
  assert.equal(
    observeRun(100, { read: unavailable, contract, now: completed + 1000 }).plan.reason,
    'mac-activity-read-incomplete',
  )
})

test('证据读取失败只报告固定阶段，不暴露API异常内容', () => {
  const value = sample()
  const files = { '.github/workflows/full.yml': 'name: Full' }
  const contract = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, evidenceHash(v)]))
  const baseRead = sourceReader(value, files)
  for (const stage of ['check-run', 'check-annotations', 'log-archive', 'step-log']) {
    const read = (path) => {
      if (path.endsWith('/check-runs/200') && stage === 'check-run')
        throw new Error('secret-example')
      if (path.includes('/annotations') && stage === 'check-annotations')
        throw new Error('secret-example')
      if (path.endsWith('/logs')) {
        if (stage === 'log-archive') throw new Error('secret-example')
        return Buffer.from('invalid zip secret-example')
      }
      return baseRead(path)
    }
    const result = observeRun(100, { read, contract, now: completed + 1000, includeSnapshot: true })
    assert.equal(result.plan.decision, 'blocked')
    assert.equal(result.plan.jobs[0].evidenceReadFailure, stage)
    assert.ok(!JSON.stringify(result).includes('secret-example'))
  }
})

test('观察不消耗预算，审计不记录日志原文或秘密', () => {
  const value = sample()
  value.evidence[200].stepLog.text = '##[error]ECONNRESET secret-example-never-copy'
  const result = plan(value)
  const record = observation(result, completed + 1000)
  assert.equal(readAudit([record], result).reserved, false)
  assert.ok(!JSON.stringify(record).includes('secret-example'))
  assert.equal(record.details.jobs[0].evidenceHash, evidenceHash(value.evidence[200].stepLog.text))
})

test('已核实下游的未来写入计划必须先reservation，重复回放不释放预算', () => {
  const value = { ...plan(), dependencyClosureVerified: true }
  const reserved = auditRecord(value, 'reservation', {}, null, completed + 1000)
  assert.equal(readAudit([reserved], value).state, 'reserved')
  const dispatched = auditRecord(
    value,
    'dispatched',
    { attempt: 2, reservation: reserved.hash },
    reserved,
    completed + 2000,
  )
  const resolved = auditRecord(
    value,
    'resolved',
    { conclusion: 'success', reservation: reserved.hash },
    dispatched,
    completed + 3000,
  )
  assert.equal(readAudit([reserved, dispatched, resolved], value).reserved, true)
  assert.throws(() => readAudit([dispatched], value), /审计链|reservation/)
  const second = auditRecord(value, 'reservation', {}, reserved, completed + 2000)
  assert.throws(() => readAudit([reserved, second], value), /第二次/)
  const observe = auditRecord(value, 'observation', {}, reserved, completed + 2000)
  assert.equal(readAudit([reserved, observe], value).reserved, true)
})

test('API响应丢失只转uncertain；不能重新reservation或重复dispatched', () => {
  const value = { ...plan(), dependencyClosureVerified: true }
  const reserved = auditRecord(value, 'reservation', {}, null, completed + 1000)
  const uncertain = auditRecord(value, 'uncertain', {}, reserved, completed + 2000)
  assert.equal(readAudit([reserved, uncertain], value).reserved, true)
  const again = auditRecord(value, 'reservation', {}, uncertain, completed + 3000)
  assert.throws(() => readAudit([reserved, uncertain, again], value), /第二次/)
  const found = auditRecord(
    value,
    'dispatched',
    { attempt: 2, reservation: reserved.hash },
    uncertain,
    completed + 3000,
  )
  assert.equal(readAudit([reserved, uncertain, found], value).state, 'dispatched')
  const duplicate = auditRecord(value, 'dispatched', found.details, found, completed + 4000)
  assert.throws(() => readAudit([reserved, uncertain, found, duplicate], value), /重复调用/)
})

test('审计乱序、篡改、换SHA、换计划及过期reservation一律拒绝', () => {
  const value = { ...plan(), dependencyClosureVerified: true }
  const record = auditRecord(value, 'reservation', {}, null, completed + 1000)
  assert.throws(() => readAudit([{ ...record, at: 'wrong' }], value), /改动/)
  assert.throws(() => readAudit([record], { ...value, sha: 'b'.repeat(40) }), /不符/)
  assert.throws(() => readAudit([record], { ...value, roots: [] }), /计划/)
  assert.throws(
    () => auditRecord(value, 'reservation', {}, null, completed + recoveryWindowMs),
    /过/,
  )
  const bad = auditRecord(
    value,
    'dispatched',
    { attempt: 3, reservation: record.hash },
    record,
    completed + 2000,
  )
  assert.throws(() => readAudit([record, bad], value), /attempt/)
})

test('平台容量与其他失败注解混杂时不恢复，不能只捡有利的一条', () => {
  const value = sample()
  Object.assign(value.jobs[0], {
    steps: [],
    runner_name: '',
    runner_id: 0,
    conclusion: 'cancelled',
  })
  value.evidence[200] = {
    annotations: [
      { annotation_level: 'failure', message: platformMessage },
      { annotation_level: 'failure', message: 'The run was cancelled by a user' },
    ],
  }
  assert.equal(plan(value).decision, 'blocked')
})

test('契约为空和越界路径拒绝；GET失败不输出gh携带的原始内容', () => {
  assert.throws(() => bindSource(() => {}, sample().run, {}), /不能为空/)
  assert.throws(() => bindSource(() => {}, sample().run, { '../../secret': 'a'.repeat(64) }))
  const read = githubReader(() => {
    throw new Error('secret-example-never-copy')
  })
  assert.throws(
    () => read('repos/slovx2/litch/actions/runs/100'),
    (error) => {
      assert.ok(!error.message.includes('secret-example'))
      return true
    },
  )
})

test('已恢复的网络报错不能掩盖最后的未知错误', () => {
  const value = sample()
  value.evidence[200].stepLog.text =
    '##[error]ECONNRESET\nretry succeeded\n##[error]Unsupported runtime'
  assert.equal(plan(value).decision, 'blocked')
  value.evidence[200].stepLog.text = 'Earlier ECONNRESET has recovered'
  assert.equal(plan(value).decision, 'blocked')
  value.evidence[200].stepLog.text = '##[error]HTTP 503'
  assert.equal(plan(value).decision, 'eligible')
})
