// 模拟核心的定时任务示例：本机和 build-01 上各有几个，两种目标、几种日程，最近一次成功、失败、排队、在跑都有，
// 有没看过的。运行跑在已有的示例会话里（本机的 s3、s4、s8，build-01 的 b2），更早的那些会话已经不在了。
// 内容全是编出来的。nas 只有原生 codex（不支持定时任务），gpu-box 还没连上过。
import type {
  TaskErrorView,
  TaskRunStatus,
  TaskRunView,
  TaskSchedule,
  TaskTarget,
  TaskView,
} from '../model-tasks.mjs'
import type { SampleLang } from './sample-text.mjs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

interface TaskText {
  standup: [name: string, prompt: string, summary: string]
  deps: [name: string, prompt: string, error: string]
  watch: [name: string, prompt: string, summary: string]
  monthly: [name: string, prompt: string]
  remind: [name: string, prompt: string]
  nightly: [name: string, prompt: string, summary: string]
  disk: [name: string, prompt: string, summary: string]
  /** 立即运行时模拟的回答；提示词里带“失败”时的错误 */
  answer: string
  failed: string
}

const TEXT: Record<SampleLang, TaskText> = {
  'zh-CN': {
    standup: [
      '每日站会摘要',
      '看一下昨天合进 main 的提交和还开着的 PR，写一份三五行的站会摘要。',
      '昨天合了 4 个提交（侧栏筛选、终端重连两处修复），开着的 PR 有 2 个在等审阅。',
    ],
    deps: [
      '依赖更新检查',
      '查一下 packages/ui 和 apps/desktop 的依赖有没有安全更新，有的话列出来，不要直接改。',
      '模型请求超时（60 秒没有回应）',
    ],
    watch: [
      '构建监控',
      '看一眼 CI 上最近一次构建，挂了的话说清楚是哪一步、可能的原因。',
      '最近一次构建通过，用时 11 分钟。',
    ],
    monthly: ['月度报告', '把这个月的提交按模块汇总成一份报告，存到 docs/reports/ 下面。'],
    remind: ['发版前提醒', '提醒我发版之前把 CHANGELOG 和版本号对一遍。'],
    nightly: [
      '夜间测试',
      '在 /srv/work/litch 跑一遍 npm run check，失败的话把失败的那几条测试和输出贴出来。',
      '全部通过：1,284 个测试，用时 6 分 12 秒。',
    ],
    disk: [
      '磁盘巡检',
      '看一下 /srv 和 /var 的磁盘占用，超过八成就说一声。',
      '/srv 用了 61%，/var 用了 37%。',
    ],
    answer: '好的，按任务的说明做完了：一切正常，没有要你处理的。',
    failed: '回合失败了：模拟的模型出错（提示词里带了“失败”）',
  },
  en: {
    standup: [
      'Daily standup summary',
      'Look at yesterday’s commits on main and the open PRs, and write a three-to-five line standup summary.',
      'Four commits landed yesterday (sidebar filter, two terminal reconnect fixes); two PRs are waiting for review.',
    ],
    deps: [
      'Dependency update check',
      'Check packages/ui and apps/desktop for security updates and list them. Don’t change anything.',
      'Model request timed out (no response in 60 seconds)',
    ],
    watch: [
      'Build watch',
      'Look at the latest CI build. If it failed, say which step and the likely cause.',
      'The latest build passed in 11 minutes.',
    ],
    monthly: [
      'Monthly report',
      'Summarize this month’s commits by module into a report under docs/reports/.',
    ],
    remind: [
      'Pre-release reminder',
      'Remind me to check the CHANGELOG and version numbers before releasing.',
    ],
    nightly: [
      'Nightly tests',
      'Run npm run check in /srv/work/litch. If anything fails, paste the failing tests and their output.',
      'All passed: 1,284 tests in 6m 12s.',
    ],
    disk: [
      'Disk check',
      'Check disk usage of /srv and /var and tell me if either is over 80%.',
      '/srv is at 61%, /var at 37%.',
    ],
    answer: 'Done as the task asked: everything looks fine, nothing needs your attention.',
    failed: 'The turn failed: the simulated model errored (the prompt said “fail”)',
  },
}

/** 立即运行时模拟的回答和失败的原因 */
export const sampleTaskAnswer = (lang: SampleLang): { answer: string; failed: string } => ({
  answer: TEXT[lang].answer,
  failed: TEXT[lang].failed,
})

/** 提示词里带这些字样时，立即运行的那一次会失败。给界面试失败的运行和系统通知用 */
export const FAILS_RUN = /失败|fail/i

interface Spec {
  id: string
  text: [name: string, prompt: string, ...string[]]
  schedule: TaskSchedule
  timezone: string
  status: TaskView['status']
  target: TaskTarget
  createdAgo: number
  /** 下一次离现在多久；null 是没有 */
  nextIn: number | null
  /** 不给是界面上建的 */
  origin?: TaskView['origin']
}

interface RunSpec {
  taskId: string
  ago: number
  status: TaskRunStatus
  threadId: string | null
  trigger?: 'scheduled' | 'manual'
  coalesced?: number
  summary?: string | null
  error?: TaskErrorView | null
  read?: boolean
}

export interface SampleTasks {
  tasks: TaskView[]
  /** 每个任务的运行记录，新的在前 */
  runs: TaskRunView[]
}

const newThread = (
  harness: string,
  cwd: string,
  workspaceId: string | null,
  model: string | null = null,
): TaskTarget => ({
  kind: 'newThread',
  harness,
  cwd,
  workspaceId,
  settings: { model, effort: null, permission: null },
})

/** 一台设备上的示例任务和运行记录。没有示例的设备是空的 */
export function sampleTasks(deviceId: string, now: number, lang: SampleLang): SampleTasks {
  const text = TEXT[lang]
  const specs: Spec[] = []
  const runSpecs: RunSpec[] = []
  if (deviceId === 'local') {
    specs.push(
      {
        id: 'task-standup',
        text: text.standup,
        schedule: { type: 'weekdays', time: '09:00' },
        timezone: 'Asia/Shanghai',
        status: 'active',
        target: newThread('dsh', '~/work/litch', 'litch'),
        createdAgo: 70 * DAY,
        nextIn: 17 * HOUR,
      },
      {
        id: 'task-deps',
        text: text.deps,
        schedule: { type: 'weekly', days: ['MO', 'TH'], time: '10:30' },
        timezone: 'Asia/Shanghai',
        status: 'active',
        target: newThread('pi', '~/work/litch', 'litch'),
        createdAgo: 30 * DAY,
        nextIn: 2 * DAY + 3 * HOUR,
      },
      {
        id: 'task-watch',
        text: text.watch,
        schedule: { type: 'interval', minutes: 30 },
        timezone: 'Asia/Shanghai',
        status: 'active',
        target: { kind: 'thread', harness: 'claude', threadId: 's8' },
        createdAgo: 5 * DAY,
        nextIn: 26 * MINUTE,
        // 模型在 s8 里用 litch_tasks 建的
        origin: { kind: 'tool', harness: 'claude', threadId: 's8' },
      },
      {
        id: 'task-monthly',
        text: text.monthly,
        schedule: { type: 'monthly', day: 31, time: '18:00' },
        timezone: 'Asia/Shanghai',
        status: 'paused',
        target: newThread('claude', '~/work/litch', 'litch', 'claude-opus-5-5'),
        createdAgo: 90 * DAY,
        nextIn: null,
      },
      {
        id: 'task-remind',
        text: text.remind,
        schedule: { type: 'once', at: '2026-10-30T16:00' },
        timezone: 'Asia/Shanghai',
        status: 'active',
        target: newThread('claude', '~/work/docs-site', 'docs'),
        createdAgo: 2 * DAY,
        nextIn: 11 * DAY,
      },
    )
    // 每日站会：最近一次在 s4 里，往前两个多月每个工作日一次（那些会话已经不在了），够翻好几页
    runSpecs.push({
      taskId: 'task-standup',
      ago: 7 * HOUR,
      status: 'succeeded',
      threadId: 's4',
      summary: text.standup[2],
    })
    for (let day = 1; day <= 64; day++) {
      runSpecs.push({
        taskId: 'task-standup',
        ago: 7 * HOUR + day * DAY,
        status: day === 9 ? 'failed' : 'succeeded',
        threadId: `gone-standup-${day}`,
        // 设备睡了一个周末那次：合并了两次
        coalesced: day === 20 ? 2 : 0,
        summary: day === 9 ? null : text.standup[2],
        error: day === 9 ? { code: 'harnessUnavailable', message: 'dsh is not running' } : null,
      })
    }
    runSpecs.push(
      // 依赖检查：最近一次失败了，还没看
      {
        taskId: 'task-deps',
        ago: 50 * MINUTE,
        status: 'failed',
        threadId: 's3',
        error: { code: 'turnFailed', message: text.deps[2] },
        read: false,
      },
      {
        taskId: 'task-deps',
        ago: 4 * DAY,
        status: 'succeeded',
        threadId: 'gone-deps-1',
        summary: lang === 'en' ? 'No security updates.' : '没有安全更新。',
      },
      // 构建监控：在 s8 里接着发，现在这一次正在跑
      { taskId: 'task-watch', ago: 2 * MINUTE, status: 'running', threadId: 's8' },
      {
        taskId: 'task-watch',
        ago: 32 * MINUTE,
        status: 'succeeded',
        threadId: 's8',
        summary: text.watch[2],
      },
      {
        taskId: 'task-watch',
        ago: 62 * MINUTE,
        status: 'succeeded',
        threadId: 's8',
        summary: text.watch[2],
        trigger: 'manual',
      },
      // 发版前提醒：刚点了立即运行，排着队（设备上同时在跑的到了上限）
      { taskId: 'task-remind', ago: MINUTE, status: 'queued', threadId: null, trigger: 'manual' },
    )
  } else if (deviceId === 'build') {
    specs.push(
      {
        id: 'task-nightly',
        text: text.nightly,
        schedule: { type: 'daily', time: '02:00' },
        timezone: 'UTC',
        status: 'active',
        target: newThread('pi', '/srv/work/litch', 'litch2'),
        createdAgo: 40 * DAY,
        nextIn: 9 * HOUR,
      },
      {
        id: 'task-disk',
        text: text.disk,
        schedule: { type: 'hourly', intervalHours: 4, minute: 0, days: null },
        timezone: 'UTC',
        status: 'active',
        target: newThread('dsh', '/srv', null),
        createdAgo: 12 * DAY,
        nextIn: 3 * HOUR,
      },
    )
    runSpecs.push(
      // 夜间测试：成功了，还没看
      {
        taskId: 'task-nightly',
        ago: 15 * HOUR,
        status: 'succeeded',
        threadId: 'b2',
        summary: text.nightly[2],
        read: false,
      },
      {
        taskId: 'task-disk',
        ago: HOUR,
        status: 'succeeded',
        threadId: 'gone-disk-1',
        summary: text.disk[2],
      },
    )
  }
  const runs: TaskRunView[] = runSpecs.map((spec, at) => {
    const startedAt = spec.status === 'queued' ? null : now - spec.ago
    const finished = spec.status !== 'queued' && spec.status !== 'running'
    return {
      id: `run-${deviceId}-${at + 1}`,
      taskId: spec.taskId,
      deviceId,
      trigger: spec.trigger ?? 'scheduled',
      scheduledFor: now - spec.ago,
      coalesced: spec.coalesced ?? 0,
      status: spec.status,
      harness: specs.find((task) => task.id === spec.taskId)?.target.harness ?? '',
      threadId: spec.threadId,
      startedAt,
      finishedAt: finished && startedAt !== null ? startedAt + 3 * MINUTE : null,
      summary: spec.summary ?? null,
      error: spec.error ?? null,
      read: finished ? (spec.read ?? true) : true,
    }
  })
  const tasks: TaskView[] = specs.map((spec) => {
    const own = runs.filter((run) => run.taskId === spec.id)
    const last = own[0] ?? null
    const failed = own.find((run) => run.status === 'failed' || run.status === 'succeeded')
    return {
      id: spec.id,
      deviceId,
      name: spec.text[0],
      prompt: spec.text[1],
      schedule: spec.schedule,
      timezone: spec.timezone,
      status: spec.status,
      target: spec.target,
      origin: spec.origin ?? { kind: 'client' },
      revision: 3,
      createdAt: now - spec.createdAgo,
      updatedAt: now - spec.createdAgo + HOUR,
      nextRunAt: spec.nextIn === null ? null : now + spec.nextIn,
      lastRunAt: last?.startedAt ?? last?.scheduledFor ?? null,
      lastRun: last,
      // 最近一次结束了的是失败的，就记着它的原因
      lastError: failed?.status === 'failed' ? failed.error : null,
      unreadRuns: own.filter((run) => !run.read).length,
    }
  })
  return { tasks, runs }
}
