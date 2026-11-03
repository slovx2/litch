// 持久预算放在GitHub issue；只信控制器机器记录，缺失/重复/作者不符都停止。
import assert from 'node:assert/strict'
import { auditRecord, readAudit } from './recovery-audit.mjs'
import { readPages } from './recovery-observe.mjs'

const base = 'repos/slovx2/litch'
const marker = '<!-- litch-ci-recovery:v1 -->'
export const auditTitle = (id) => `[CI recovery] run ${id}`
export const encodeAudit = (plan, record, controller) =>
  `${marker}\n基础设施恢复审计；关闭此issue不会清除预算。\n\n\`\`\`json\n${JSON.stringify({ plan, record, controller })}\n\`\`\`\n`

export function decodeAudit(item, read) {
  if (!item.body?.startsWith(marker)) return null
  assert.equal(item.user?.id, 41898282, '审计作者必须是GitHub Actions bot')
  assert.equal(item.user?.login, 'github-actions[bot]')
  assert.equal(item.user?.type, 'Bot')
  const match = item.body.match(/\n```json\n([^\n]+)\n```\n$/)
  assert.ok(match, '机器审计格式损坏')
  const value = JSON.parse(match[1])
  const { controller, record, plan } = value
  assert.ok(Number.isSafeInteger(controller.runId) && controller.runId > 0)
  assert.match(controller.sha, /^[a-f0-9]{40}$/)
  const run = read(`${base}/actions/runs/${controller.runId}`)
  assert.equal(run.repository?.full_name, 'slovx2/litch')
  assert.equal(run.head_sha, controller.sha)
  assert.equal(run.path, '.github/workflows/recovery-controller.yml')
  assert.ok(['workflow_run', 'workflow_dispatch', 'schedule'].includes(run.event))
  assert.equal(controller.attempt, 1, '控制器自身不重跑')
  assert.equal(run.run_attempt, 1)
  assert.ok(Date.parse(item.created_at) >= Date.parse(run.created_at), '审计早于控制器')
  assert.ok(Date.parse(record.at) >= Date.parse(run.created_at) - 30_000)
  assert.equal(record.source, `${plan.repository}:${plan.runId}:${plan.sha}`)
  return value
}

export function loadLedger(read, source) {
  const since = source.createdAt ? `&since=${encodeURIComponent(source.createdAt)}` : ''
  const issues = readPages(
    read,
    `${base}/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc${since}`,
  ).filter((issue) => !issue.pull_request && issue.title === auditTitle(source.runId))
  assert.ok(issues.length <= 1, '同run审计issue不唯一')
  if (!issues.length) return null
  const issue = issues[0]
  const initial = decodeAudit(issue, read)
  assert.ok(initial, '审计issue缺少机器记录')
  assert.equal(initial.plan.sha, source.sha, '审计run绑定了其他SHA')
  const entries = [initial]
  for (const comment of readPages(read, `${base}/issues/${issue.number}/comments`)) {
    const value = decodeAudit(comment, read)
    if (value) entries.push(value)
  }
  const plan = entries.find((entry) => entry.record.type === 'reservation')?.plan ?? initial.plan
  assert.equal(plan.runId, source.runId)
  assert.equal(plan.sha, source.sha)
  const state = readAudit(
    entries.map((entry) => entry.record),
    plan,
  )
  return { issue: issue.number, plan, entries, ...state }
}

export function persistRecord({
  read,
  write,
  controller,
  plan,
  type,
  details = {},
  now = Date.now(),
}) {
  const ledger = loadLedger(read, plan)
  if (type === 'reservation') assert.ok(!ledger?.reserved, '预算已预占')
  const record = auditRecord(plan, type, details, ledger?.last, now)
  const body = encodeAudit(plan, record, controller)
  if (ledger) {
    write(`${base}/issues/${ledger.issue}/comments`, { body })
  } else {
    assert.ok(['reservation', 'observation'].includes(type), '不能无前序追加调用结果')
    write(`${base}/issues`, { title: auditTitle(plan.runId), body })
  }
  // 只有原记录可读回、链和来源都通过，调用方才可进行下一步。
  const stored = loadLedger(read, plan)
  assert.equal(stored?.last.hash, record.hash, '审计没有可靠写入或发生并发修改')
  return stored
}
