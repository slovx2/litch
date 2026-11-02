// 工作流结束时读 Actions 的实际 step 时间；所有 attempt 都列出，重跑不能抹掉首败。
import { appendFileSync } from 'node:fs'

const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_TOKEN } =
  process.env
const lines = [
  '## 阶段耗时与首次失败',
  '缓存命中见各 job 的“缓存与首次失败”；手机逐 flow 结果见对应 shard。',
]
for (let attempt = 1; attempt <= Number(GITHUB_RUN_ATTEMPT); attempt++) {
  const jobs = []
  for (let page = 1; ; page++) {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    )
    if (!response.ok) throw new Error(`读取 job 失败：${response.status}`)
    const result = await response.json()
    jobs.push(...result.jobs)
    if (result.jobs.length < 100) break
  }
  const failures = jobs
    .flatMap((job) =>
      (job.steps ?? [])
        .filter((step) => ['failure', 'timed_out'].includes(step.conclusion))
        .map((step) => ({ job: job.name, step: step.name, at: step.completed_at })),
    )
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
  lines.push(`\n### Attempt ${attempt}${attempt > 1 ? '（人工/外部重跑）' : '（首轮）'}`)
  lines.push(`首次失败：${failures[0] ? `${failures[0].job} / ${failures[0].step}` : '无'}。`)
  lines.push('| Job / 阶段 | 结果 | 秒 |', '|---|---|---:|')
  for (const job of jobs) {
    const jobSeconds = job.completed_at
      ? (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000
      : '进行中'
    lines.push(
      `| **${job.name.replaceAll('|', '\\|')}** | ${job.conclusion ?? job.status} | ${jobSeconds} |`,
    )
    for (const step of job.steps ?? []) {
      if (!step.started_at || !step.completed_at || step.conclusion === 'skipped') continue
      const seconds = (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000
      lines.push(
        `| ${job.name.replaceAll('|', '\\|')} / ${step.name.replaceAll('|', '\\|')} | ${step.conclusion} | ${seconds} |`,
      )
    }
  }
}
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
