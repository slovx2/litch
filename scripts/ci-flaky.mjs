#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  checkoutSha,
  recordEvent,
  repository,
  summary,
  testResults,
  workflow,
} from './ci/flaky-ledger.mjs'

const defaultLedger = fileURLToPath(new URL('../docs/ci/flaky-ledger.json', import.meta.url))
const help = `Full 偶发失败账（同时记录 CI；只读 GitHub，不触发重跑、不修改工作流或 issue）
  node scripts/ci-flaky.mjs summary
  node scripts/ci-flaky.mjs scan --run ID [--attempt 1] [--job 'native / checks']
  node scripts/ci-flaky.mjs record --run ID --job 'native / checks' --case 'client:projections'
    --pass-run ID [--pass-attempt 1] [--pass-job 'native / checks']
  node scripts/ci-flaky.mjs record --run ID --job JOB --case CASE
    --local-reference URL或报告路径 --note '复跑命令、源码、环境与通过结果'
没有通过依据时登记为待核实，不计数。所有命令支持 --ledger PATH。
--case 省略时仅在提取到恰好一个失败用例时自动采用。
提取不了时用 --manual --case CASE --failure-note '具体失败与日志位置'。
--attempt 默认为 1，不因 GitHub 当前已重跑而读错首次失败。
达到 3 次只是提示交用户审批，不自动移出 Full。`

function number(value, name) {
  if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${name} 必须为正整数`)
  }
  return Number(value)
}

// 不经 shell，不输出令牌；gh 使用调用者已有的 GitHub 登录态，仅调用 GET。
export function github(path, raw = false) {
  const result = execFileSync(
    'gh',
    ['api', '--method', 'GET', '--allow-escape-sequences', `repos/${repository}/${path}`],
    {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return raw ? result : JSON.parse(result)
}

export function loadRun(runId, attempt, api = github) {
  const run = api(`actions/runs/${runId}/attempts/${attempt}`)
  if (
    run.id !== runId ||
    run.run_attempt !== attempt ||
    ![workflow, '.github/workflows/ci.yml'].includes(run.path) ||
    run.repository?.full_name !== repository
  )
    throw new Error('不是指定仓库的 Full 或 CI run/attempt')
  const jobs = []
  for (let page = 1; ; page++) {
    const result = api(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`)
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count) break
    if (!result.jobs.length) throw new Error('作业分页未完整读取')
  }
  return { run, jobs }
}

function selectJob(jobs, name) {
  const found = jobs.filter((job) => job.name === name)
  if (found.length !== 1) throw new Error(`作业名必须唯一匹配：${name}`)
  return found[0]
}

export function prepareRecord(options, api = github) {
  const runId = number(options.run, '--run')
  const attempt = number(options.attempt ?? '1', '--attempt')
  const { run, jobs } = loadRun(runId, attempt, api)
  const job = selectJob(jobs, options.job)
  if (
    job.status !== 'completed' ||
    !['failure', 'timed_out', 'cancelled'].includes(job.conclusion)
  ) {
    throw new Error('指定作业尚未完成或并未失败')
  }
  const log = api(`actions/jobs/${job.id}/logs`, true)
  const sha = checkoutSha(log)
  const failed = testResults(log).filter((result) => !result.passed)
  const test = options.case ?? (failed.length === 1 ? failed[0].name : undefined)
  if (!test) throw new Error('没有唯一失败用例；先 scan，再用 --case 指定')
  if (
    !failed.some((result) => result.name === test) &&
    !(options.manual && options['failure-note']?.trim())
  ) {
    throw new Error('日志未提取到该失败；核对名称，或 --manual 并提供 --failure-note')
  }
  if (options['pass-run'] && options['local-reference'])
    throw new Error('不能同时指定远端和本地通过依据')
  let evidence = { kind: 'pending', note: options.note ?? '尚无同 SHA 通过或本地复跑通过的证据' }
  if (options['pass-run']) {
    const passId = number(options['pass-run'], '--pass-run')
    const passAttempt = number(options['pass-attempt'] ?? '1', '--pass-attempt')
    const pass = loadRun(passId, passAttempt, api)
    const passJob = selectJob(pass.jobs, options['pass-job'] ?? options.job)
    if (passJob.status !== 'completed') throw new Error('通过证据的作业尚未完成')
    const passLog = api(`actions/jobs/${passJob.id}/logs`, true)
    if (
      checkoutSha(passLog) !== sha ||
      !testResults(passLog).some((result) => result.name === test && result.passed)
    ) {
      throw new Error('通过日志不是同 SHA，或未证明指定用例通过')
    }
    evidence = {
      kind: 'same-sha-pass',
      runId: passId,
      attempt: passAttempt,
      jobId: passJob.id,
      sha,
      reference: passJob.html_url,
      note: options.note ?? `同 SHA 的 ${passJob.name} 日志确认该用例通过`,
    }
  } else if (options['local-reference']) {
    if (!options.note?.trim()) throw new Error('本地复跑必须用 --note 说明命令、源码、环境和结果')
    evidence = { kind: 'local-rerun', reference: options['local-reference'], note: options.note }
  } else if (options['pass-job'] || options['pass-attempt']) {
    throw new Error('--pass-job/--pass-attempt 必须与 --pass-run 一起使用')
  }
  return {
    job: job.name,
    test,
    event: {
      runId,
      attempt,
      jobId: job.id,
      sha,
      date: job.started_at,
      trigger: run.event,
      url: job.html_url,
      failure: options['failure-note'] ?? `日志报告用例失败：${test}`,
      evidence,
    },
  }
}

export function saveRecord(path, record) {
  // 同一 checkout 的并发写入拒绝重叠；跨分支账目由集成时合并，计数从记录计算。
  const lock = `${path}.lock`
  const fd = openSync(lock, 'wx')
  const temporary = `${path}.${process.pid}.tmp`
  try {
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    const next = recordEvent(ledger, record)
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, path)
    return next
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}

export function main(args = process.argv.slice(2), api = github) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      run: { type: 'string' },
      attempt: { type: 'string' },
      job: { type: 'string' },
      case: { type: 'string' },
      ledger: { type: 'string' },
      'pass-run': { type: 'string' },
      'pass-attempt': { type: 'string' },
      'pass-job': { type: 'string' },
      'local-reference': { type: 'string' },
      note: { type: 'string' },
      manual: { type: 'boolean' },
      'failure-note': { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help) return console.log(help)
  const [command = 'summary'] = positionals
  if (positionals.length > 1) throw new Error('只接受一个子命令')
  const path = values.ledger ?? defaultLedger
  if (command === 'summary') return console.log(summary(JSON.parse(readFileSync(path, 'utf8'))))
  if (command === 'record')
    return console.log(summary(saveRecord(path, prepareRecord(values, api))))
  if (command !== 'scan') throw new Error(help)
  const { jobs } = loadRun(
    number(values.run, '--run'),
    number(values.attempt ?? '1', '--attempt'),
    api,
  )
  const selected = values.job
    ? [selectJob(jobs, values.job)]
    : jobs.filter((job) => ['failure', 'timed_out', 'cancelled'].includes(job.conclusion))
  for (const job of selected) {
    try {
      const log = api(`actions/jobs/${job.id}/logs`, true)
      const failed = testResults(log)
        .filter((result) => !result.passed)
        .map((result) => result.name)
      console.log(
        JSON.stringify({
          job: job.name,
          jobId: job.id,
          sha: checkoutSha(log),
          failed,
          note: failed.length ? '仅提取失败，不自动认定偶发' : '未提取用例，请读日志后手工指定',
          url: job.html_url,
        }),
      )
    } catch (error) {
      console.log(
        JSON.stringify({ job: job.name, jobId: job.id, error: error.message, url: job.html_url }),
      )
      process.exitCode = 1
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
