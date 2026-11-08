// 【桩】经理 issue 的客户端数据源，M1（设备、核心数据线）接上真实通道后整份删掉。
// 界面线（M2）先对着 M0 契约开发：这里在内存里实现 litch/manager/issues/list 与 issue/* 七个方法的语义，
// 编号沿用“字母-n”（用户 2026-11-08 改定）：特殊 issue 保留原编号 D-n/R-n/P-n/S-…，从当前看板即时投影；
// 普通 issue 用 X-n，只存在内存里。契约里的 ManagerIssueId 还是 #n，M1 改契约后去掉这里的 as。
// 只在浏览器里的模拟核心（桌面 litch-ui 预览、手机 preview）启用；Electron 与手机真机上 supported=false，
// 界面照旧显示四类控制台，不会出现“假成功”。时间一律是毫秒（与核心投影后的看板同单位）。
import type {
  ManagerIssue,
  ManagerIssueComment,
  ManagerIssueFollowUp,
  ManagerIssueHead,
  ManagerIssueId,
  ManagerIssueKind,
  ManagerIssuePage,
  ManagerIssueStatus,
  ManagerIssueTimelineEntry,
  ManagerOrdinaryStatus,
} from '../../protocol/src/manager-issues.mjs'
import type { ManagerRelation, ManagerRelationTarget } from '../../protocol/src/manager-posts.mjs'
import type { ManagerBoardView } from './model-manager.mjs'
import {
  filterManagerIssues,
  type ManagerIssueFilter,
  type ManagerIssueSummary,
  managerIssueFilterKey,
  managerIssueHead,
  managerIssueSummary,
} from './projection/manager-issue-list.mjs'

/** 界面读的 issue 视图；真实核心应按同样形状放进看板订阅（见 M2 回报里的接口清单）。 */
export interface ManagerIssuesView {
  deviceId: string
  managerId: string
  /**
   * 设备宣告了 litchManagerIssues：true 用 issue 控制台；false 是比应用旧的设备服务（回到四类并写明原因）；
   * null 尚未知（桩未启用时也是 null，界面照旧四类、不写原因）
   */
  supported: boolean | null
  /** 按 managerIssueFilterKey 分的列表页（已读到的部分） */
  pages: Record<string, Omit<ManagerIssuePage, 'query'>>
  details: Partial<Record<ManagerIssueId, ManagerIssue>>
  summary: ManagerIssueSummary
  loading: string[]
  error: string | null
}

export type ManagerIssueStubScene = 'default' | 'empty' | 'many' | 'old' | 'forbidden'
const PAGE = 30

interface Shelf {
  issues: Map<ManagerIssueId, ManagerIssue>
  counter: number
  limits: Map<string, number>
  board: ManagerBoardView | null
  view: ManagerIssuesView | null
}

export class ManagerIssueStubError extends Error {
  readonly code: 'conflict' | 'notFound' | 'forbidden' | 'unsupported' | 'invalid'
  constructor(code: ManagerIssueStubError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function createManagerIssueStub(options: {
  now(): number
  /** 界面换语言后报错文字跟着换；播种的示例数据按播种时的语言 */
  lang: 'zh-CN' | 'en' | (() => 'zh-CN' | 'en')
  /** 预览里模拟经理：跟进开着时，用户评论后由它安排一条经理回复（暂停时不回，对应 D-101） */
  later?: (run: () => void) => void
}) {
  const shelves = new Map<string, Shelf>()
  const listeners = new Set<() => void>()
  let enabled = false
  let scene: ManagerIssueStubScene = 'default'
  let seq = 0
  const lang = () => (typeof options.lang === 'function' ? options.lang() : options.lang)
  const t = (zh: string, en: string) => (lang() === 'zh-CN' ? zh : en)
  const keyOf = (deviceId: string, managerId: string) => JSON.stringify([deviceId, managerId])
  const emit = () => {
    for (const shelf of shelves.values()) shelf.view = null
    for (const listener of listeners) listener()
  }
  const shelf = (deviceId: string, managerId: string): Shelf => {
    const key = keyOf(deviceId, managerId)
    let value = shelves.get(key)
    if (!value) {
      value = {
        issues: new Map(),
        counter: 0,
        limits: new Map(),
        board: null,
        view: null,
      }
      shelves.set(key, value)
    }
    return value
  }
  const nextId = (s: Shelf): ManagerIssueId => `X-${++s.counter}` as ManagerIssueId
  const supported = () => enabled && scene !== 'old'

  /** 特殊 issue：从看板投影，编号就是原来的 D-n/R-n/P-n/S-…。 */
  const project = (s: Shelf, board: ManagerBoardView) => {
    type Source = { alias: string; build(id: ManagerIssueId): ManagerIssue }
    const sources: Source[] = []
    for (const d of board.decisions)
      sources.push({
        alias: d.id,
        build: (id) =>
          special(id, d.id, 'decision', d.title, d.background, d.status, d.createdAt, d.updatedAt, {
            revision: d.revision,
            questions: d.discussion?.messages ?? [],
            quick: {
              decision: {
                options: d.options,
                answerable: d.status === 'open',
                ignored: d.status === 'ignored',
              },
            },
          }),
      })
    for (const r of board.requests ?? [])
      sources.push({
        alias: r.id,
        build: (id) =>
          special(
            id,
            r.id,
            'request',
            r.title,
            r.description,
            r.response?.ignored ? 'ignored' : r.status,
            r.createdAt,
            r.updatedAt,
            {
              revision: r.revision,
              questions: board.posts?.find((one) => one.id === r.id)?.discussion?.messages ?? [],
              quick: {
                request: { buttonLabel: r.buttonLabel ?? null, deliverable: r.status === 'open' },
              },
            },
          ),
      })
    for (const p of board.posts ?? []) {
      if (p.kind !== 'report' && p.kind !== 'suggestion') continue
      sources.push({
        alias: p.id,
        build: (id) =>
          special(
            id,
            p.id,
            p.kind,
            p.title,
            p.body,
            p.kind === 'report' ? (p.unread ? 'unread' : 'read') : 'pending',
            p.createdAt,
            p.updatedAt,
            {
              revision: p.revision,
              questions: p.discussion?.messages ?? [],
              unread: p.kind === 'report' && Boolean(p.unread),
              quick:
                p.kind === 'report'
                  ? { report: { unread: Boolean(p.unread), canMarkRead: Boolean(p.unread) } }
                  : {
                      suggestion: {
                        proposalId: p.proposalId ?? '',
                        canStart: true,
                        reviewed: false,
                      },
                    },
            },
          ),
      })
    }
    for (const source of sources) {
      const id = source.alias as ManagerIssueId
      const before = s.issues.get(id)
      const fresh = source.build(id)
      // 评论、跟进开关是 issue 外壳自己的；看板刷新不能把它们冲掉
      s.issues.set(
        id,
        before
          ? {
              ...fresh,
              followUp: before.followUp,
              discussion: { ...fresh.discussion, comments: before.discussion.comments },
              timeline: before.timeline,
              unread: fresh.unread || (before.unread && fresh.kind !== 'report'),
            }
          : fresh,
      )
    }
  }

  const special = (
    id: ManagerIssueId,
    _alias: string,
    kind: Exclude<ManagerIssueKind, 'ordinary'>,
    title: string,
    body: string,
    status: ManagerIssueStatus,
    createdAt: number,
    updatedAt: number,
    extra: Pick<ManagerIssue, 'revision' | 'quick'> & {
      unread?: boolean
      questions?: ManagerIssue['discussion']['questions']
    },
  ): ManagerIssue => ({
    id,
    aliases: [],
    kind,
    title,
    body,
    status,
    stateGroup:
      kind === 'report'
        ? status === 'unread'
          ? 'unread'
          : 'read'
        : status === 'open' || status === 'pending' || status === 'endorsed'
          ? 'pending'
          : 'closed',
    author: { kind: 'manager' },
    revision: extra.revision,
    createdAt,
    updatedAt,
    followUp: {
      state: status === 'open' || status === 'pending' || status === 'endorsed' ? 'on' : 'off',
      changedAt: createdAt,
      changedBy: 'manager',
    },
    discussion: { comments: [], questions: extra.questions ?? [], summary: null },
    relations: [],
    timeline: [
      { id: `created:${id}`, kind: 'created', actor: 'manager', at: createdAt, summary: '' },
    ],
    quick: extra.quick,
    unread: extra.unread ?? false,
  })

  const ordinary = (
    s: Shelf,
    input: {
      title: string
      body: string
      author: 'user' | 'manager'
      status?: ManagerOrdinaryStatus
      followUp?: ManagerIssueFollowUp
      at: number
      comments?: { author: 'user' | 'manager'; body: string; at: number }[]
      related?: ManagerRelationTarget[]
      unread?: boolean
    },
  ): ManagerIssue => {
    const id = nextId(s)
    const comments: ManagerIssueComment[] = (input.comments ?? []).map((one) => ({
      id: `c${++seq}`,
      revision: 1,
      author: { kind: one.author },
      body: one.body,
      createdAt: one.at,
      updatedAt: one.at,
      replyTo: null,
    }))
    const relations: ManagerRelation[] = (input.related ?? []).map((target) => ({
      id: `rel${++seq}`,
      from: { kind: 'issue', target: id },
      to: target,
      kind: 'related',
      at: input.at,
      by: input.author,
    }))
    const status = input.status ?? 'open'
    const updatedAt = Math.max(input.at, ...comments.map((one) => one.createdAt))
    const issue: ManagerIssue = {
      id,
      aliases: [],
      kind: 'ordinary',
      title: input.title,
      body: input.body,
      status,
      stateGroup: status === 'resolved' || status === 'closed' ? 'closed' : 'open',
      author: { kind: input.author },
      revision: 1,
      createdAt: input.at,
      updatedAt,
      followUp: { state: input.followUp ?? 'on', changedAt: input.at, changedBy: input.author },
      discussion: { comments, questions: [], summary: null },
      relations,
      timeline: [
        { id: `created:${id}`, kind: 'created', actor: input.author, at: input.at, summary: '' },
        ...comments.map(
          (one): ManagerIssueTimelineEntry => ({
            id: `comment:${one.id}`,
            kind: 'comment',
            actor: one.author.kind,
            at: one.createdAt,
            summary: '',
            commentId: one.id,
          }),
        ),
      ],
      quick: {},
      unread: input.unread ?? false,
    }
    s.issues.set(id, issue)
    return issue
  }

  const seed = (s: Shelf) => {
    if (scene === 'empty') return
    const now = options.now()
    const hour = 3_600_000
    if (scene === 'many') {
      const states: ManagerOrdinaryStatus[] = [
        'open',
        'in_progress',
        'blocked',
        'resolved',
        'closed',
      ]
      for (let i = 0; i < 120; i++)
        ordinary(s, {
          title: t(
            `批量议题 ${i + 1}：检查第 ${i + 1} 项`,
            `Bulk issue ${i + 1}: check item ${i + 1}`,
          ),
          body: t(
            '用来看大量 issue 时的列表和“加载更多”。',
            'Used to check long lists and Load more.',
          ),
          author: i % 3 ? 'manager' : 'user',
          status: states[i % states.length] ?? 'open',
          followUp: i % 4 ? 'on' : 'off',
          at: now - (120 - i) * hour,
          unread: i % 7 === 0,
        })
      return
    }
    ordinary(s, {
      title: t('远程 Worker 的长期跟进', 'Long-running follow-up for remote workers'),
      body: t(
        '远程 Worker 偶尔掉线，先记下来，有新的现象再补充。',
        'Remote workers drop now and then. Track it here and add new symptoms as they appear.',
      ),
      author: 'manager',
      status: 'in_progress',
      followUp: 'off',
      at: now - 30 * hour,
      related: [{ kind: 'item', target: 'I-2', label: t('排查掉线', 'Investigate drops') }],
    })
    ordinary(s, {
      title: t(
        '手机端验收时登录态在重启后丢失，需要确认是安全存储的问题还是会话恢复顺序的问题，并补一条回归用例',
        'Sign-in state is lost after a restart during phone acceptance; confirm whether secure storage or session restore order is at fault, and add a regression test',
      ),
      body: t(
        '重启应用后需要重新配对。\n\n复现：\n\n1. 配对手机\n2. 杀掉应用再打开\n3. 设备列表为空\n\n怀疑和安全存储的读取时机有关。',
        'The phone has to pair again after the app restarts.\n\nSteps:\n\n1. Pair the phone\n2. Kill and reopen the app\n3. The device list is empty\n\nPossibly related to when secure storage is read.',
      ),
      author: 'user',
      status: 'open',
      at: now - 5 * hour,
      unread: true,
      comments: [
        {
          author: 'user',
          body: t(
            '安卓 15 上稳定复现，iOS 没试。',
            'Reproduces every time on Android 15; not tried on iOS.',
          ),
          at: now - 4 * hour,
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
          at: now - 2 * hour,
        },
      ],
      related: [
        { kind: 'thread', target: 'line-mobile', label: t('手机登录排查', 'Phone sign-in') },
      ],
    })
    ordinary(s, {
      title: t('发布说明的写法', 'How to write release notes'),
      body: '',
      author: 'user',
      status: 'resolved',
      at: now - 50 * hour,
    })
    ordinary(s, {
      title: t('Windows 安装包体积', 'Windows installer size'),
      body: t('暂时不处理。', 'Not now.'),
      author: 'manager',
      status: 'closed',
      followUp: 'off',
      at: now - 80 * hour,
    })
    ordinary(s, {
      title: t('CI 夜间偶发失败', 'Nightly CI flakes'),
      body: t('等上游修复。', 'Waiting on an upstream fix.'),
      author: 'manager',
      status: 'blocked',
      at: now - 10 * hour,
    })
    // 长讨论：几十条评论来回
    ordinary(s, {
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
      at: now - 70 * hour,
      comments: Array.from({ length: 40 }, (_, i) => ({
        author: i % 2 ? ('manager' as const) : ('user' as const),
        body:
          i % 2
            ? t(
                `第 ${i + 1} 条：经理的回复。空闲时换版本的方案已经验证过一台设备，还要看正在跑回合时的表现。`,
                `#${i + 1}: manager reply. Swapping versions while idle worked on one device; still need to check behavior mid-turn.`,
              )
            : t(
                `第 ${i + 1} 条：我的补充。正在跑的会话不能被打断，升级要等空闲。`,
                `#${i + 1}: my note. Running sessions must not be interrupted; wait until idle.`,
              ),
        at: now - (70 - i * 1.5) * hour,
      })),
      related: [
        { kind: 'item', target: 'I-1', label: t('升级流程', 'Upgrade flow') },
        {
          kind: 'url',
          target: 'https://example.com/upgrade-notes',
          label: t('升级说明', 'Upgrade notes'),
        },
      ],
    })
    // 再来一批，凑够翻页（每页 30）和各种组合
    const topics = t(
      '侧栏分组拖拽|终端中文输入法|差异视图折叠|定时任务失败重试|内置浏览器下载|手机通知去重|工作树清理|日志轮转|技能手册同步|Pi 压缩失败|OpenCode 会话恢复|ACP 权限卡片|Chrome 扩展上架|远程文件预览|搜索结果排序|会话标题自动生成',
      'Sidebar group drag|Terminal CJK input|Diff folding|Scheduled task retries|Browser downloads|Phone notification dedupe|Worktree cleanup|Log rotation|Manual skill sync|Pi compaction failure|OpenCode session restore|ACP permission cards|Chrome extension listing|Remote file preview|Search ranking|Auto session titles',
    ).split('|')
    const states: ManagerOrdinaryStatus[] = ['open', 'in_progress', 'blocked', 'resolved', 'closed']
    for (let i = 0; i < 32; i++)
      ordinary(s, {
        title: `${topics[i % topics.length]}${i >= topics.length ? t('（二期）', ' (phase 2)') : ''}`,
        body: i % 5 === 4 ? '' : t('记录现象和下一步。', 'Symptoms and next steps.'),
        author: i % 3 ? 'manager' : 'user',
        status: states[i % states.length] ?? 'open',
        followUp: i % 4 === 3 ? 'off' : 'on',
        at: now - (100 + i * 3) * hour,
        unread: i % 9 === 1,
        ...(i % 6 === 0
          ? {
              comments: [
                {
                  author: 'manager' as const,
                  body: t('先放着，有空再看。', 'Parked for now.'),
                  at: now - (99 + i * 3) * hour,
                },
              ],
            }
          : {}),
      })
    // 特殊 issue 也有几条评论，转成讨论后能看到内容
    for (const issue of [...s.issues.values()]
      .filter((one) => one.kind !== 'ordinary')
      .slice(0, 3)) {
      const at = issue.createdAt + hour
      const comment: ManagerIssueComment = {
        id: `c${++seq}`,
        revision: 1,
        author: { kind: 'user' },
        body: t('这个先别急，我想再讨论一下。', 'Let us discuss this a bit more first.'),
        createdAt: at,
        updatedAt: at,
        replyTo: null,
      }
      s.issues.set(issue.id, {
        ...issue,
        discussion: { ...issue.discussion, comments: [comment] },
        timeline: [
          ...issue.timeline,
          {
            id: `comment:${comment.id}`,
            kind: 'comment',
            actor: 'user',
            at,
            summary: '',
            commentId: comment.id,
          },
        ],
      })
    }
  }

  const guard = () => {
    if (!supported())
      throw new ManagerIssueStubError(
        'unsupported',
        t('设备服务版本较旧，不支持 issue。', 'The device service does not support issues.'),
      )
    if (scene === 'forbidden')
      throw new ManagerIssueStubError(
        'forbidden',
        t('没有权限读取这个经理的 issue。', 'You do not have access to this manager’s issues.'),
      )
  }
  const find = (s: Shelf, ref: string) => {
    const issue = s.issues.get(ref as ManagerIssueId)
    if (!issue)
      throw new ManagerIssueStubError('notFound', t('找不到这个 issue。', 'Issue not found.'))
    return issue
  }
  const checkRevision = (issue: ManagerIssue, revision: number) => {
    if (issue.revision !== revision)
      throw new ManagerIssueStubError(
        'conflict',
        t(
          '这个 issue 刚被改过，请重新读取后再试。',
          'This issue just changed. Reload it and try again.',
        ),
      )
  }
  const touch = (
    s: Shelf,
    issue: ManagerIssue,
    entry: Omit<ManagerIssueTimelineEntry, 'id' | 'at'>,
  ) => {
    const at = options.now()
    const next = {
      ...issue,
      updatedAt: at,
      timeline: [...issue.timeline, { id: `t${++seq}`, at, ...entry }],
    }
    s.issues.set(issue.id, next)
    return next
  }

  return {
    configure(next: { enabled?: boolean; scene?: ManagerIssueStubScene }) {
      if (next.enabled !== undefined) enabled = next.enabled
      if (next.scene !== undefined && next.scene !== scene) {
        scene = next.scene
        // 换场景整份重来：重新播种、重新投影
        for (const s of shelves.values()) {
          const board = s.board
          s.issues.clear()
          s.counter = 0
          s.board = null
          if (board) this.syncBoard(board.deviceId, board.managerId, board)
        }
      }
      emit()
    },
    get scene() {
      return scene
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 看板到了或变了：重新投影特殊 issue（第一次顺带播种普通 issue） */
    syncBoard(deviceId: string, managerId: string, board: ManagerBoardView) {
      const s = shelf(deviceId, managerId)
      if (s.board === board) return
      const first = s.board === null && s.counter === 0
      s.board = board
      if (!enabled) return
      if (first) {
        // 先投影旧对象（迁移顺序），再放普通 issue
        project(s, board)
        seed(s)
      } else project(s, board)
      emit()
    },
    view(deviceId: string, managerId: string): ManagerIssuesView {
      const s = shelf(deviceId, managerId)
      if (s.view) return s.view
      const heads = [...s.issues.values()].map(managerIssueHead)
      const pages: ManagerIssuesView['pages'] = {}
      if (supported() && scene !== 'forbidden')
        for (const [key, limit] of s.limits) {
          const filter = JSON.parse(key) as [
            ManagerIssueKind[],
            ManagerIssueStatus[],
            ('user' | 'manager')[],
            ManagerIssueFollowUp | 'all',
            boolean,
            ManagerIssueFilter['order'],
          ]
          const rows = filterManagerIssues(heads, {
            kinds: filter[0],
            statuses: filter[1],
            authors: filter[2],
            followUp: filter[3],
            unread: filter[4],
            order: filter[5],
          })
          pages[key] = {
            entries: rows.slice(0, limit),
            total: rows.length,
            nextCursor: rows.length > limit ? String(limit) : null,
          }
        }
      s.view = {
        deviceId,
        managerId,
        supported: enabled ? scene !== 'old' : null,
        pages,
        details: Object.fromEntries(s.issues),
        summary: managerIssueSummary(heads),
        loading: [],
        error:
          scene === 'forbidden'
            ? t(
                '没有权限读取这个经理的 issue。',
                'You do not have access to this manager’s issues.',
              )
            : null,
      }
      return s.view
    },
    async list(deviceId: string, managerId: string, filter: ManagerIssueFilter, more = false) {
      guard()
      const s = shelf(deviceId, managerId)
      const key = managerIssueFilterKey(filter)
      s.limits.set(key, more ? (s.limits.get(key) ?? PAGE) + PAGE : (s.limits.get(key) ?? PAGE))
      emit()
    },
    async read(deviceId: string, managerId: string, ref: string) {
      guard()
      return { issue: find(shelf(deviceId, managerId), ref) }
    },
    async create(
      deviceId: string,
      managerId: string,
      params: { title: string; body: string; followUp?: ManagerIssueFollowUp },
    ) {
      guard()
      if (!params.title.trim())
        throw new ManagerIssueStubError('invalid', t('标题不能为空。', 'Title is required.'))
      const issue = ordinary(shelf(deviceId, managerId), {
        title: params.title.trim(),
        body: params.body,
        author: 'user',
        followUp: params.followUp ?? 'on',
        at: options.now(),
      })
      emit()
      return { issue }
    },
    async update(
      deviceId: string,
      managerId: string,
      params: {
        id: string
        revision: number
        patch: { title?: string; body?: string; status?: ManagerOrdinaryStatus }
      },
    ) {
      guard()
      const s = shelf(deviceId, managerId)
      const issue = find(s, params.id)
      checkRevision(issue, params.revision)
      if (issue.kind !== 'ordinary')
        throw new ManagerIssueStubError(
          'invalid',
          t('特殊 issue 用各自的快速处理。', 'Use the quick actions for this issue type.'),
        )
      const { status, ...text } = params.patch
      let next: ManagerIssue = {
        ...issue,
        ...text,
        ...(status
          ? { status, stateGroup: status === 'resolved' || status === 'closed' ? 'closed' : 'open' }
          : {}),
        revision: issue.revision + 1,
      }
      next = touch(s, next, {
        kind: status ? 'status' : 'edited',
        actor: 'user',
        summary: status ?? '',
      })
      emit()
      return { issue: next }
    },
    async comment(
      deviceId: string,
      managerId: string,
      params: { id: string; revision: number; body: string },
    ) {
      guard()
      const s = shelf(deviceId, managerId)
      const issue = find(s, params.id)
      checkRevision(issue, params.revision)
      const at = options.now()
      const comment: ManagerIssueComment = {
        id: `c${++seq}`,
        revision: 1,
        author: { kind: 'user' },
        body: params.body,
        createdAt: at,
        updatedAt: at,
        replyTo: null,
      }
      const next = touch(
        s,
        {
          ...issue,
          discussion: { ...issue.discussion, comments: [...issue.discussion.comments, comment] },
        },
        { kind: 'comment', actor: 'user', summary: '', commentId: comment.id },
      )
      emit()
      if (options.later && next.followUp.state === 'on')
        options.later(() => {
          const now = s.issues.get(next.id)
          if (now?.followUp.state !== 'on') return
          const at = options.now()
          const reply: ManagerIssueComment = {
            id: `c${++seq}`,
            revision: 1,
            author: { kind: 'manager' },
            body: t('收到，我看一下再回复。', 'Got it. I will look and reply.'),
            createdAt: at,
            updatedAt: at,
            replyTo: comment.id,
          }
          s.issues.set(now.id, {
            ...touch(
              s,
              {
                ...now,
                discussion: { ...now.discussion, comments: [...now.discussion.comments, reply] },
              },
              { kind: 'comment', actor: 'manager', summary: '', commentId: reply.id },
            ),
            unread: true,
          })
          emit()
        })
      return { issue: next }
    },
    async follow(
      deviceId: string,
      managerId: string,
      params: { id: string; revision: number; state: ManagerIssueFollowUp },
    ) {
      guard()
      const s = shelf(deviceId, managerId)
      const issue = find(s, params.id)
      checkRevision(issue, params.revision)
      const at = options.now()
      const next = touch(
        s,
        { ...issue, followUp: { state: params.state, changedAt: at, changedBy: 'user' } },
        { kind: 'followUp', actor: 'user', summary: params.state },
      )
      emit()
      return { issue: next }
    },
    async seen(deviceId: string, managerId: string, params: { id: string }) {
      guard()
      const s = shelf(deviceId, managerId)
      const issue = find(s, params.id)
      if (!issue.unread || issue.kind === 'report') return { issue }
      const next = { ...issue, unread: false }
      s.issues.set(issue.id, next)
      emit()
      return { issue: next }
    },
  }
}

export type ManagerIssueStub = ReturnType<typeof createManagerIssueStub>
export type { ManagerIssueHead }
