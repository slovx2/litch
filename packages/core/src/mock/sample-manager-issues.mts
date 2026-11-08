// 预览用的经理 issue 示例（模拟核心播种，时间是毫秒）：让人在预览里把 issue 控制台整个走一遍。
// m1 是完整的一套（五种状态、跟进开关、两种创建者、未读、关联、长标题、几十条评论、空讨论，够翻一页）；
// m3 是 120 条批量 issue，看数量和“加载更多”；其余经理不播种，看空状态。
// 特殊 issue（D/R/P/S）由 mock-manager-issues.mts 从看板投影，这里只给头三条各补一条评论。
import type {
  ManagerIssue,
  ManagerIssueComment,
  ManagerIssueFollowUp,
  ManagerIssueId,
  ManagerIssueTimelineEntry,
  ManagerOrdinaryStatus,
} from '../../../protocol/src/manager-issues.mjs'
import type {
  ManagerRelation,
  ManagerRelationTarget,
} from '../../../protocol/src/manager-posts.mjs'
import { managerIssuePending } from '../projection/manager-public-issues.mjs'

type Lang = 'zh-CN' | 'en'
const HOUR = 3_600_000
const STATES: ManagerOrdinaryStatus[] = ['open', 'in_progress', 'blocked', 'resolved', 'closed']

interface OrdinaryInput {
  title: string
  body: string
  author: 'user' | 'manager'
  status?: ManagerOrdinaryStatus
  followUp?: ManagerIssueFollowUp
  at: number
  comments?: { author: 'user' | 'manager'; body: string; at: number }[]
  related?: ManagerRelationTarget[]
  unread?: boolean
}

function ordinary(n: number, input: OrdinaryInput): ManagerIssue {
  const id = `X-${n}` as ManagerIssueId
  const comments: ManagerIssueComment[] = (input.comments ?? []).map((one, i) => ({
    id: `sample-${id}-c${i + 1}`,
    revision: 1,
    author: { kind: one.author },
    body: one.body,
    createdAt: one.at,
    updatedAt: one.at,
    replyTo: null,
  }))
  const relations: ManagerRelation[] = (input.related ?? []).map((target, i) => ({
    id: `sample-${id}-r${i + 1}`,
    from: { kind: 'issue', target: id },
    to: target,
    kind: 'related',
    at: input.at,
    by: input.author,
  }))
  const status = input.status ?? 'open'
  const issue: ManagerIssue = {
    id,
    kind: 'ordinary',
    title: input.title,
    body: input.body,
    status,
    stateGroup: 'open',
    author: { kind: input.author },
    revision: 1,
    createdAt: input.at,
    updatedAt: Math.max(input.at, ...comments.map((one) => one.createdAt)),
    followUp: { state: input.followUp ?? 'on', changedAt: input.at, changedBy: input.author },
    discussion: { comments, questions: [], summary: null },
    relations,
    timeline: [
      { id: `created:${id}`, kind: 'created', actor: input.author, at: input.at, summary: '' },
      ...comments.map(
        (one): ManagerIssueTimelineEntry => ({
          id: `comment:${one.id}:1`,
          kind: 'comment',
          actor: one.author.kind,
          at: one.createdAt,
          summary: one.body,
          commentId: one.id,
        }),
      ),
    ],
    quick: {},
    unread: input.unread ?? false,
  }
  issue.stateGroup = managerIssuePending(issue) ? 'open' : 'closed'
  return issue
}

/** 经理 m1 的完整示例：手写 6 条覆盖各种边界，再生成 32 条凑够翻页（每页 30）和各种过滤组合。 */
function richIssues(now: number, t: (zh: string, en: string) => string): ManagerIssue[] {
  const list: OrdinaryInput[] = [
    {
      title: t('远程 Worker 的长期跟进', 'Long-running follow-up for remote workers'),
      body: t(
        '远程 Worker 偶尔掉线，先记下来，有新的现象再补充。',
        'Remote workers drop now and then. Track it here and add new symptoms as they appear.',
      ),
      author: 'manager',
      status: 'in_progress',
      followUp: 'off',
      at: now - 30 * HOUR,
      related: [{ kind: 'item', target: 'I-2', label: t('排查掉线', 'Investigate drops') }],
    },
    {
      title: t(
        '手机端验收时登录态在重启后丢失，需要确认是安全存储的问题还是会话恢复顺序的问题，并补一条回归用例',
        'Sign-in state is lost after a restart during phone acceptance; confirm whether secure storage or session restore order is at fault, and add a regression test',
      ),
      body: t(
        '重启应用后需要重新配对。\n\n复现：\n\n1. 配对手机\n2. 杀掉应用再打开\n3. 设备列表为空\n\n怀疑和安全存储的读取时机有关。',
        'The phone has to pair again after the app restarts.\n\nSteps:\n\n1. Pair the phone\n2. Kill and reopen the app\n3. The device list is empty\n\nPossibly related to when secure storage is read.',
      ),
      author: 'user',
      at: now - 5 * HOUR,
      unread: true,
      comments: [
        {
          author: 'user',
          body: t(
            '安卓 15 上稳定复现，iOS 没试。',
            'Reproduces every time on Android 15; not tried on iOS.',
          ),
          at: now - 4 * HOUR,
        },
        {
          author: 'manager',
          body: t(
            '已经派工作线查了。初步看是启动时先读了设备列表、后解锁安全存储，读到的是空值。\n\n下一步：\n\n- 调整读取顺序\n- 补一条冷启动的回归用例\n- 在 iOS 上复验\n\n'.repeat(
              3,
            ),
            'A workline is on it. At first glance the device list is read before secure storage unlocks, so it reads empty.\n\nNext:\n\n- Reorder the reads\n- Add a cold-start regression test\n- Re-check on iOS\n\n'.repeat(
              3,
            ),
          ),
          at: now - 2 * HOUR,
        },
      ],
      related: [
        { kind: 'thread', target: 'line-mobile', label: t('手机登录排查', 'Phone sign-in') },
      ],
    },
    {
      title: t('发布说明的写法', 'How to write release notes'),
      body: '',
      author: 'user',
      status: 'resolved',
      at: now - 50 * HOUR,
    },
    {
      title: t('Windows 安装包体积', 'Windows installer size'),
      body: t('暂时不处理。', 'Not now.'),
      author: 'manager',
      status: 'closed',
      followUp: 'off',
      at: now - 80 * HOUR,
    },
    {
      title: t('CI 夜间偶发失败', 'Nightly CI flakes'),
      body: t('等上游修复。', 'Waiting on an upstream fix.'),
      author: 'manager',
      status: 'blocked',
      at: now - 10 * HOUR,
    },
    {
      title: t(
        '设备服务升级流程要不要改成后台静默',
        'Should device-service upgrades run silently in the background',
      ),
      body: t(
        '现在升级要用户点确认，远程设备多时很烦。讨论一下静默升级的边界。',
        'Upgrades need a confirmation today, which is tedious with many remote devices. Let us agree on limits for silent upgrades.',
      ),
      author: 'user',
      status: 'in_progress',
      at: now - 70 * HOUR,
      comments: Array.from({ length: 40 }, (_, i) => ({
        author: i % 2 ? ('manager' as const) : ('user' as const),
        body:
          i % 2
            ? t(
                `第 ${i + 1} 条：经理的回复。空闲时换版本的方案已经验证过一台设备，还要看正在跑回合时的表现。`,
                `Reply ${i + 1} from the manager: swapping versions while idle worked on one device; behavior mid-turn still needs checking.`,
              )
            : t(
                `第 ${i + 1} 条：我的补充。正在跑的会话不能被打断，升级要等空闲。`,
                `Note ${i + 1} from me: running sessions must not be interrupted; wait until idle.`,
              ),
        at: now - (70 - i * 1.5) * HOUR,
      })),
      related: [
        { kind: 'item', target: 'I-1', label: t('升级流程', 'Upgrade flow') },
        {
          kind: 'url',
          target: 'https://example.com/upgrade-notes',
          label: t('升级说明', 'Upgrade notes'),
        },
      ],
    },
  ]
  const topics = t(
    '侧栏分组拖拽|终端中文输入法|差异视图折叠|定时任务失败重试|内置浏览器下载|手机通知去重|工作树清理|日志轮转|技能手册同步|Pi 压缩失败|OpenCode 会话恢复|ACP 权限卡片|Chrome 扩展上架|远程文件预览|搜索结果排序|会话标题自动生成',
    'Sidebar group drag|Terminal CJK input|Diff folding|Scheduled task retries|Browser downloads|Phone notification dedupe|Worktree cleanup|Log rotation|Manual skill sync|Pi compaction failure|OpenCode session restore|ACP permission cards|Chrome extension listing|Remote file preview|Search ranking|Auto session titles',
  ).split('|')
  for (let i = 0; i < 32; i++)
    list.push({
      title: `${topics[i % topics.length]}${i >= topics.length ? t('（二期）', ' (phase 2)') : ''}`,
      body: i % 5 === 4 ? '' : t('记录现象和下一步。', 'Symptoms and next steps.'),
      author: i % 3 ? 'manager' : 'user',
      status: STATES[i % STATES.length] ?? 'open',
      followUp: i % 4 === 3 ? 'off' : 'on',
      at: now - (100 + i * 3) * HOUR,
      unread: i % 9 === 1,
      ...(i % 6 === 0
        ? {
            comments: [
              {
                author: 'manager' as const,
                body: t('先放着，有空再看。', 'Parked for now.'),
                at: now - (99 + i * 3) * HOUR,
              },
            ],
          }
        : {}),
    })
  return list.map((input, i) => ordinary(i + 1, input))
}

/** 经理 m3：120 条批量 issue，看数量、过滤和“加载更多”。 */
function bulkIssues(now: number, t: (zh: string, en: string) => string): ManagerIssue[] {
  return Array.from({ length: 120 }, (_, i) =>
    ordinary(i + 1, {
      title: t(`批量议题 ${i + 1}：检查第 ${i + 1} 项`, `Bulk issue ${i + 1}: check item ${i + 1}`),
      body: t('用来看大量 issue 时的列表和“加载更多”。', 'Used to check long lists and Load more.'),
      author: i % 3 ? 'manager' : 'user',
      status: STATES[i % STATES.length] ?? 'open',
      followUp: i % 4 ? 'on' : 'off',
      at: now - (120 - i) * HOUR,
      unread: i % 7 === 0,
    }),
  )
}

/**
 * 给一个经理播种：返回要加进去的普通 issue，以及补过评论的特殊 issue（同编号覆盖）。
 * specials 是刚从看板投影出来的 D/R/P/S。
 */
export function sampleManagerIssues(
  managerId: string,
  specials: readonly ManagerIssue[],
  now: number,
  lang: Lang,
): ManagerIssue[] {
  const t = (zh: string, en: string) => (lang === 'zh-CN' ? zh : en)
  if (managerId === 'm3') return bulkIssues(now, t)
  if (managerId !== 'm1') return []
  const discussed = specials.slice(0, 3).map((issue, i): ManagerIssue => {
    const at = issue.createdAt + HOUR
    const comment: ManagerIssueComment = {
      id: `sample-${issue.id}-c1`,
      revision: 1,
      author: { kind: 'user' },
      body: t('这个先别急，我想再讨论一下。', 'Let us discuss this a bit more first.'),
      createdAt: at,
      updatedAt: at,
      replyTo: null,
    }
    return {
      ...issue,
      discussion: { ...issue.discussion, comments: [comment] },
      timeline: [
        ...issue.timeline,
        {
          id: `comment:${comment.id}:1`,
          kind: 'comment',
          actor: 'user',
          at: at + i,
          summary: comment.body,
          commentId: comment.id,
        },
      ],
    }
  })
  return [...discussed, ...richIssues(now, t)]
}
