import { stripVTControlCharacters } from 'node:util'

export const workflow = '.github/workflows/full.yml'
export const repository = 'slovx2/litch'

// 用户已决定模拟器分片仅按需手动运行；不能误伤 mobile-build 或手机 JS 单测。
const mobileE2E = (job) => /^mobile \(\d+\)$/.test(job)
export const mobileExclusion = {
  reason:
    '用户已决定手机模拟器 E2E 不进默认 Full/schedule，mobile-e2e 默认 false；2026-11-07 重申。',
  reference: 'docs/reference/ci-flaky.md#认定和计数',
}

export function logLines(log) {
  return stripVTControlCharacters(log)
    .split(/\r?\n/)
    .map((line) => line.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, ''))
}

// 从实际 checkout 取 SHA；workflow_dispatch 的 head_sha 可能只是调度源码。
export function checkoutSha(log) {
  const lines = logLines(log)
  const shas = new Set()
  for (let i = 0; i < lines.length - 1; i++) {
    if (/git log -1 --format=%H\s*$/.test(lines[i]) && /^[a-f0-9]{40}$/.test(lines[i + 1])) {
      shas.add(lines[i + 1])
    }
  }
  if (shas.size !== 1) throw new Error('日志缺少唯一实际 checkout SHA，不能用 head_sha 代替')
  return [...shas][0]
}

export function testResults(log) {
  const results = new Map()
  const add = (name, passed) => {
    // 同一日志先败后过仍保留失败，Node 的末尾摘要不会重复产生用例。
    if (name && !/^(failing tests:|tests? failed)$/.test(name)) {
      results.set(name, results.has(name) ? results.get(name) && passed : passed)
    }
  }
  for (const raw of logLines(log)) {
    const line = raw.trim()
    const structured = /^(MAC_CHECK_RESULT|CLIENT_CHECK_RESULT) (\{.*\})$/.exec(line)
    if (structured) {
      const result = JSON.parse(structured[2])
      const name = structured[1] === 'MAC_CHECK_RESULT' ? result.id : `client:${result.name}`
      add(name, result.code === 0 && !result.signal)
      continue
    }
    const node = /^[✖✔] (.+?) \([\d.]+m?s\)$/.exec(line)
    if (node) add(node[1], line.startsWith('✔'))
    const tap = /^(not ok|ok) \d+ - (.+?)(?: # .*)?$/.exec(line)
    if (tap && !/ # (?:SKIP|TODO)\b/i.test(line)) add(tap[2], tap[1] === 'ok')
    const go = /^--- (FAIL|PASS): (\S+) \([\d.]+s\)$/.exec(line)
    if (go) add(go[2], go[1] === 'PASS')
  }
  return [...results].map(([name, passed]) => ({ name, passed }))
}

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const positive = (value) => Number.isSafeInteger(value) && value > 0
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)

export function validateEvent(event) {
  if (
    !positive(event.runId) ||
    !positive(event.attempt) ||
    !positive(event.jobId) ||
    !sha(event.sha) ||
    !Number.isFinite(Date.parse(event.date)) ||
    !['schedule', 'workflow_dispatch', 'workflow_call', 'push'].includes(event.trigger) ||
    !nonempty(event.failure) ||
    !nonempty(event.url)
  )
    throw new Error('失败记录缺少 run/attempt/job/SHA/日期/失败依据')
  const evidence = event.evidence
  if (!evidence || !['pending', 'local-rerun', 'same-sha-pass'].includes(evidence.kind)) {
    throw new Error('证据类型必须为 pending、local-rerun 或 same-sha-pass')
  }
  if (!nonempty(evidence.note)) throw new Error('必须说明证据或待核实原因')
  if (evidence.kind !== 'pending' && !nonempty(evidence.reference)) {
    throw new Error('确认偶发必须有可追溯的通过依据')
  }
  if (
    evidence.kind === 'same-sha-pass' &&
    (evidence.sha !== event.sha ||
      !positive(evidence.runId) ||
      !positive(evidence.attempt) ||
      !positive(evidence.jobId) ||
      (evidence.runId === event.runId &&
        evidence.attempt === event.attempt &&
        evidence.jobId === event.jobId))
  )
    throw new Error('通过证据必须是同 SHA 的另一轮执行')
}

export function validateLedger(ledger) {
  if (
    ledger.version !== 1 ||
    ledger.repository !== repository ||
    ledger.workflow !== workflow ||
    !Array.isArray(ledger.cases)
  )
    throw new Error('不支持的账本格式或仓库/工作流')
  const keys = new Set()
  for (const item of ledger.cases) {
    const key = JSON.stringify([item.job, item.test])
    if (
      !nonempty(item.job) ||
      !nonempty(item.test) ||
      keys.has(key) ||
      !['active', 'excluded'].includes(item.status) ||
      !Array.isArray(item.events)
    ) {
      throw new Error('用例键重复或格式无效')
    }
    if (
      item.status === 'excluded' &&
      (!nonempty(item.exclusion?.reason) || !nonempty(item.exclusion?.reference))
    )
      throw new Error('已排除项必须保留用户决定的依据')
    if (mobileE2E(item.job) && item.status !== 'excluded') {
      throw new Error('手机模拟器 E2E 已排除，不准计数')
    }
    keys.add(key)
    const seen = new Set()
    for (const event of item.events) {
      validateEvent(event)
      const id = `${event.runId}/${event.attempt}/${event.jobId}`
      if (seen.has(id)) throw new Error('同一次执行被重复登记')
      seen.add(id)
    }
  }
  return ledger
}

export function recordEvent(ledger, { job, test, event }) {
  validateLedger(ledger)
  validateEvent(event)
  if (!nonempty(job) || !nonempty(test)) throw new Error('必须指定作业和用例名')
  const next = structuredClone(ledger)
  let item = next.cases.find((entry) => entry.job === job && entry.test === test)
  if (!item) {
    item = { job, test, status: 'active', events: [] }
    if (mobileE2E(job)) {
      item.status = 'excluded'
      item.exclusion = { ...mobileExclusion }
    }
    next.cases.push(item)
  }
  const previous = item.events.find(
    (entry) =>
      entry.runId === event.runId && entry.attempt === event.attempt && entry.jobId === event.jobId,
  )
  if (previous) {
    if (previous.sha !== event.sha) throw new Error('同一执行的 SHA 冲突')
    if (previous.evidence.kind === 'pending' && event.evidence.kind !== 'pending') {
      previous.evidence = event.evidence
    }
  } else {
    item.events.push(event)
  }
  item.events.sort((a, b) => a.runId - b.runId || a.attempt - b.attempt || a.jobId - b.jobId)
  next.cases.sort((a, b) =>
    JSON.stringify([a.job, a.test]).localeCompare(JSON.stringify([b.job, b.test])),
  )
  return validateLedger(next)
}

export function counts(item) {
  const confirmed = new Set(
    item.events.filter((event) => event.evidence.kind !== 'pending').map((event) => event.runId),
  )
  const pending = new Set(
    item.events.filter((event) => !confirmed.has(event.runId)).map((event) => event.runId),
  )
  return { count: item.status === 'excluded' ? 0 : confirmed.size, pending: pending.size }
}

export function summary(ledger) {
  validateLedger(ledger)
  return ledger.cases
    .map((item) => {
      const { count, pending } = counts(item)
      const state =
        item.status === 'excluded'
          ? '已排除，不计数'
          : count >= 3
            ? '需要用户审批是否移出 Full（经理提交看板决策；批准前保留）'
            : count === 2
              ? '接近 3 次审批门槛'
              : '继续观察'
      return `${item.job} → ${item.test}：${count} 次；待核实 ${pending} 次；${state}`
    })
    .join('\n')
}
