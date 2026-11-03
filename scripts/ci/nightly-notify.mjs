// 单条机器拥有的夜间跟进issue；不是恢复预算，不打release-blocker、不发版、不重跑。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { nightlySummary } from './nightly-health.mjs'
import { readPages } from './recovery-observe.mjs'
import { evidenceHash } from './recovery-policy.mjs'

const base = 'repos/slovx2/litch'
const title = '[CI nightly] 夜间调度与绿色基线跟进'
const marker = '<!-- litch-nightly-health:v1 -->'

export function nightlyWriter(execute = execFileSync) {
  return (method, path, body) => {
    assert.ok(
      (method === 'POST' && path === `${base}/issues`) ||
        (method === 'PATCH' && /^repos\/slovx2\/litch\/issues\/[1-9]\d*$/.test(path)),
    )
    const output = execute(
      'gh',
      ['api', '--method', method, '--input', '-', '--allow-escape-sequences', path],
      {
        input: JSON.stringify(body),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    return JSON.parse(output)
  }
}

export function notifyNightly(report, controller, { read, write, now = Date.now() }) {
  const issues = readPages(
    read,
    `${base}/issues?state=all&creator=github-actions%5Bbot%5D`,
    undefined,
  ).filter((issue) => !issue.pull_request && issue.title === title)
  assert.ok(issues.length <= 1, '夜间监测issue重复，不能任意选一个')
  const issue = issues[0]
  let previous
  if (issue) {
    assert.equal(issue.user?.id, 41898282)
    assert.equal(issue.user?.login, 'github-actions[bot]')
    assert.ok(issue.body.startsWith(`${marker}\n`))
    previous = JSON.parse(issue.body.split('\n')[1])
    assert.equal(previous.schema, 1)
    const priorRun = read(`${base}/actions/runs/${previous.controller.runId}`)
    assert.equal(priorRun.head_sha, previous.controller.sha)
    assert.equal(priorRun.path, '.github/workflows/recovery-controller.yml')
    assert.equal(priorRun.repository?.full_name, 'slovx2/litch')
  }
  if (!report.alerts.length && !issue) return { state: 'no-alert' }
  const fingerprint = evidenceHash({
    alerts: report.alerts,
    latestRun: report.latestRun,
    greenRun: report.greenRun,
  })
  const desiredState = report.alerts.length ? 'open' : 'closed'
  if (
    issue &&
    previous.fingerprint === fingerprint &&
    issue.state === desiredState &&
    (desiredState === 'closed' || now - Date.parse(previous.checkedAt) < 60 * 60_000)
  )
    return { state: 'unchanged', issue: issue.number }
  const checkedAt = new Date(now).toISOString()
  const metadata = { schema: 1, controller, fingerprint, checkedAt }
  const body = `${marker}\n${JSON.stringify(metadata)}\n\n${nightlySummary(report, checkedAt)}\n维护运行：https://github.com/slovx2/litch/actions/runs/${controller.runId}\n\n跟进责任：Litch开发经理分诊并安排修复；本issue不解除或新增发版门禁。\n`
  const response = issue
    ? write('PATCH', `${base}/issues/${issue.number}`, { body, state: desiredState })
    : write('POST', `${base}/issues`, { title, body })
  assert.ok(Number.isSafeInteger(response.number))
  if (issue) assert.equal(response.number, issue.number)
  const confirmed = read(`${base}/issues/${response.number}`)
  assert.equal(confirmed.body, body)
  assert.equal(confirmed.state, desiredState)
  return { state: issue ? 'updated' : 'created', issue: response.number }
}
