// CI/Prepare只读展示监测心跳；读取不可用只提示，不改变任何门禁结论。
import { appendFileSync } from 'node:fs'
import { latestState } from './maintenance-state.mjs'
import { nightlySummary } from './nightly-health.mjs'
import { githubReader } from './recovery-observe.mjs'

let summary
try {
  const read = githubReader(undefined, { budgetMs: 20_000, requestMs: 5000 })
  const metadata = read('repos/slovx2/litch')
  const state = latestState(read, 'ci-nightly-health', {
    defaultBranch: metadata.default_branch,
    currentRun: Number(process.env.GITHUB_RUN_ID),
  })
  summary = state
    ? nightlySummary(state.value.report, state.checkedAt) +
      `监测心跳距现在 ${Math.floor((Date.now() - Date.parse(state.checkedAt)) / 60_000)} 分钟；${state.value.notification?.state ? `通知状态：${state.value.notification.state}` : '通知尚未确认'}。这是历史快照，候选仍实时检查基线与夜间红灯。\n`
    : '## 夜间维护心跳\n尚无可信定时监测快照；不能据此宣称夜间健康。候选沿用原门禁。\n'
} catch {
  summary = '## 夜间维护心跳\n心跳读取失败或检查点不可信；不能据此宣称夜间健康。候选沿用原门禁。\n'
}
console.log(summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
