// 持久预算放在GitHub issue；只信控制器机器记录，缺失/重复/作者不符都停止。
import assert from 'node:assert/strict'
import { auditRecord, readAudit } from './recovery-audit.mjs'
import { readPages } from './recovery-observe.mjs'

const base = 'repos/slovx2/litch'
const marker = '<!-- litch-ci-recovery:v1 -->'
const auditLabel = {
  name: 'ci-recovery',
  color: 'ededed',
  description: 'CI基础设施恢复审计；关闭不释放预算',
}
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

export function loadLedger(read, source, issueNumber) {
  const since = source.createdAt ? `&since=${encodeURIComponent(source.createdAt)}` : ''
  if (issueNumber !== undefined) assert.ok(Number.isSafeInteger(issueNumber) && issueNumber > 0)
  const issues =
    issueNumber === undefined
      ? readPages(
          read,
          `${base}/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc${since}`,
        ).filter((issue) => !issue.pull_request && issue.title === auditTitle(source.runId))
      : [read(`${base}/issues/${issueNumber}`)]
  assert.ok(issues.length <= 1, '同run审计issue不唯一')
  if (!issues.length) return null
  const issue = issues[0]
  assert.equal(issue.title, auditTitle(source.runId), '读回的issue不属于源run')
  assert.ok(!issue.pull_request, '审计不是PR')
  if (issueNumber !== undefined) assert.equal(issue.number, issueNumber)
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
  return { issue: issue.number, issueState: issue.state, plan, entries, ...state }
}

export function ensureAuditClosed(ledger, { read, write }) {
  if (ledger.issueState === 'closed') return
  assert.equal(ledger.issueState, 'open')
  write(`${base}/issues/${ledger.issue}`, { state: 'closed' }, 'PATCH')
  const issue = read(`${base}/issues/${ledger.issue}`)
  assert.equal(issue.number, ledger.issue)
  assert.equal(issue.title, auditTitle(ledger.plan.runId))
  assert.equal(issue.user?.id, 41898282)
  assert.equal(issue.state, 'closed', '审计issue关闭未确认；预算保留，不调用恢复')
  ledger.issueState = 'closed'
}

function ensureAuditLabel(read, write) {
  const labels = readPages(read, `${base}/labels`)
  if (labels.some((label) => label.name === auditLabel.name)) return
  // 不重试POST。若其他维护者同时建标签导致冲突，下次只读发现即可，不能盲目再创建。
  write(`${base}/labels`, auditLabel)
  assert.equal(read(`${base}/labels/ci-recovery`).name, auditLabel.name)
}

export function persistRecord({
  read,
  write,
  controller,
  plan,
  type,
  details = {},
  now = Date.now(),
  wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  issueNumber,
}) {
  const ledger = loadLedger(read, plan, issueNumber)
  if (type === 'reservation') assert.ok(!ledger?.reserved, '预算已预占')
  const record = auditRecord(plan, type, details, ledger?.last, now)
  const body = encodeAudit(plan, record, controller)
  issueNumber = ledger?.issue
  if (ledger) {
    ensureAuditClosed(ledger, { read, write })
    write(`${base}/issues/${issueNumber}/comments`, { body })
  } else {
    assert.ok(['reservation', 'observation'].includes(type), '不能无前序追加调用结果')
    ensureAuditLabel(read, write)
    const response = write(`${base}/issues`, {
      title: auditTitle(plan.runId),
      body,
      labels: ['ci-recovery'],
    })
    issueNumber = response.number
  }
  assert.ok(Number.isSafeInteger(issueNumber) && issueNumber > 0, '审计写入未返回issue编号')
  // 新建后按精确编号读回，不依赖issue列表的即时可见性。只重复GET，不重复POST；
  // 评论尚不可见最多等1秒、2秒，坏链/错误作者/来源异常立即停止。
  let stored
  for (const delay of [0, 1000, 2000]) {
    if (delay) wait(delay)
    stored = loadLedger(read, plan, issueNumber)
    if (stored?.last.hash === record.hash) {
      ensureAuditClosed(stored, { read, write })
      return stored
    }
  }
  assert.equal(stored?.last.hash, record.hash, '审计没有可靠写入或发生并发修改')
  return stored
}
