// 夜间监测只报告和跟进，不补触发Full、不放宽候选基线，也不恢复手机模拟器自动运行。
import assert from 'node:assert/strict'

const minute = 60_000
const day = 24 * 60 * minute
export const fullCron = '17 19 * * *'
export function nightlySlot(time) {
  const date = new Date(time)
  const slot = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 19, 17)
  return slot > time ? slot - day : slot
}

export function evaluateNightly({ runs, now, monitoringSince, workflowState, previousHeartbeat }) {
  assert.ok(Number.isFinite(now) && Number.isFinite(monitoringSince) && monitoringSince <= now)
  const byId = new Map()
  for (const run of runs) {
    if (
      run.event !== 'schedule' ||
      run.path !== '.github/workflows/full.yml' ||
      !Number.isSafeInteger(run.id) ||
      !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      Date.parse(run.created_at) > now
    )
      continue
    const prior = byId.get(run.id)
    if (!prior || run.run_attempt > prior.run_attempt) byId.set(run.id, run)
  }
  const nightlies = [...byId.values()].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )
  const alerts = []
  const notices = []
  const slots = []
  const last = nightlySlot(now)
  // 不追认启用前的漏跑；保留最近三天的缺口，不用次日run偷偷填补前日缺口。
  for (
    let slot = Math.max(
      nightlySlot(monitoringSince) + (nightlySlot(monitoringSince) < monitoringSince ? day : 0),
      last - 2 * day,
    );
    slot <= last;
    slot += day
  ) {
    const matching = nightlies.filter((run) => nightlySlot(Date.parse(run.created_at)) === slot)
    const ageMinutes = (now - slot) / minute
    const item = { expectedAt: new Date(slot).toISOString(), runIds: matching.map((r) => r.id) }
    slots.push(item)
    if (matching.length > 1)
      alerts.push({
        key: `ambiguous:${slot}`,
        severity: 'warning',
        message: '同一预期槽出现多个schedule run，无法从REST确认各自原始触发槽；请分诊',
        runIds: item.runIds,
      })
    if (matching.length) continue
    if (ageMinutes >= 24 * 60)
      alerts.push({
        key: `missing:${slot}`,
        severity: 'critical',
        message: `预期 ${item.expectedAt} 超过24小时没有对应run，疑似漏跑`,
      })
    else if (ageMinutes >= 8 * 60)
      alerts.push({
        key: `missing:${slot}`,
        severity: 'warning',
        message: `预期 ${item.expectedAt} 超过8小时没有创建run，调度迟到`,
      })
    else if (ageMinutes >= 90)
      notices.push(`预期 ${item.expectedAt} 已过90分钟，尚无run；仅摘要提示`)
  }
  if (workflowState !== 'active')
    alerts.push({
      key: 'workflow-state',
      severity: 'critical',
      message: 'Full工作流未启用或状态未知；需维护者检查，不自动启用',
    })
  const latest = nightlies[0]
  if (latest && latest.status !== 'completed')
    notices.push(
      `夜间 #${latest.id} 已创建，${latest.acquired ? '已有runner执行' : '仍等待runner'}；不是未创建run`,
    )
  const completed = nightlies.find((run) => run.status === 'completed')
  if (completed?.conclusion === 'success' && completed.coverage !== 'complete') {
    alerts.push({
      key: 'nightly-proof',
      severity: 'warning',
      runIds: [completed.id],
      message: '夜间显示success但完整证明无法核实；不能据此认定绿色基线',
    })
  }
  if (completed && completed.conclusion !== 'success') {
    const failures = completed.failures ?? []
    const mobileOnly =
      completed.coverage === 'release-only' &&
      failures.some((j) => /^mobile \(\d+\)$/.test(j.name)) &&
      failures.every((j) => /^mobile \(\d+\)$/.test(j.name) || j.name === 'report')
    alerts.push({
      key: 'nightly-result',
      severity: 'warning',
      runIds: [completed.id],
      message: mobileOnly
        ? '最近夜间仅手机模拟器失败：建立修复跟进，不挡发版'
        : '最近夜间非手机领域失败或范围未知：由经理分诊，既有发版阻断规则保持',
      mobileOnly,
    })
  }
  const green = nightlies
    .filter(
      (run) =>
        run.status === 'completed' && run.conclusion === 'success' && run.coverage === 'complete',
    )
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]
  const greenAgeHours =
    (now - (green ? Date.parse(green.updated_at) : monitoringSince)) / (60 * minute)
  if (green && (!Number.isFinite(greenAgeHours) || greenAgeHours < 0))
    throw new Error('绿色基线时间无效')
  if (greenAgeHours >= 36)
    alerts.push({
      key: 'green-baseline',
      severity: greenAgeHours >= 48 ? 'critical' : 'warning',
      message:
        greenAgeHours >= 48
          ? '48小时内没有已验证绿色夜间基线：候选按原规则退回全量'
          : '绿色夜间基线已过36小时，请跟进；48小时规则不变',
    })
  if (!green)
    notices.push('尚无可核实的绿色夜间完整证明；不把手动Full当夜间基线，候选仍自行校验48小时及祖先')
  const heartbeatGapMinutes = previousHeartbeat
    ? (now - Date.parse(previousHeartbeat)) / minute
    : null
  if (heartbeatGapMinutes !== null && heartbeatGapMinutes > 90)
    notices.push(`监测心跳间隔 ${Math.floor(heartbeatGapMinutes)} 分钟，监测本身也曾迟到`)
  const samples = nightlies
    .filter((run) => Date.parse(run.created_at) >= monitoringSince)
    .slice(0, 14)
    .map((run) => ({
      runId: run.id,
      attempt: run.run_attempt,
      createdAt: run.created_at,
      inferredDelayMinutes: Math.round(
        (Date.parse(run.created_at) - nightlySlot(Date.parse(run.created_at))) / minute,
      ),
    }))
  if (samples.length >= 14)
    notices.push('已有14次真实schedule样本，请经理复核8小时阈值；手动dispatch与同run重跑不增加样本')
  return {
    status: alerts.length ? 'attention' : 'healthy',
    alerts,
    notices,
    slots,
    samples,
    monitoringSince: new Date(monitoringSince).toISOString(),
    latestRun: latest?.id ?? null,
    greenRun: green?.id ?? null,
    greenAgeHours: green ? greenAgeHours : null,
    heartbeatGapMinutes,
    reviewThreshold: samples.length >= 14,
  }
}

export function nightlySummary(report, checkedAt) {
  return [
    '## 夜间Full与维护心跳',
    `本次核对：${checkedAt}；状态：${report.status}。`,
    `最近夜间：${report.latestRun ? `https://github.com/slovx2/litch/actions/runs/${report.latestRun}` : '尚无'}；绿色证明：${report.greenRun ?? '尚无'}。`,
    ...report.alerts.map(
      (a) => `- ${a.message}${a.runIds?.length ? `（run ${a.runIds.join(', ')}）` : ''}`,
    ),
    ...report.notices.map((n) => `- ${n}`),
    `真实schedule样本：${report.samples.length}/14。延迟按创建时间推定触发槽，超过一天的延迟不能唯一归槽。`,
    '本监测也依赖GitHub调度；平台整体漏触发时无法独立实时告警。摘要不替代发版门禁。',
    '',
  ].join('\n')
}
