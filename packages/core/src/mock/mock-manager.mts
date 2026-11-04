import type { SuggestionView } from '../model-suggestions.mjs'
import { mockPosts, sampleReport } from './manager-posts.mjs'
// 模拟经理：与真实通道同形的快照、增量和命令，答复按项校验版本。

import { forwardedManagerQuestion } from '../../../protocol/src/manager-question.mjs'
import { formatSessionEvent } from '../../../protocol/src/session-tree.mjs'
import { ChannelError, type Commands } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type {
  ManagerBoardView,
  ManagerChangeView,
  ManagerDecisionView,
  ManagerFeaturesView,
  ManagerView,
} from '../model-manager.mjs'
import { phrase } from '../phrase.mjs'
import type { MockTasksHost } from './mock-tasks.mjs'
import {
  type ManagerSessionSummary,
  sampleManagerHistory,
  sampleManagerOpening,
  sampleManagers,
} from './sample-manager.mjs'
import { SERVICE_VERSIONS } from './sample-service.mjs'

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** 属于 litchManagerPosts 的命令 */
const POSTS_COMMANDS = new Set([
  'managers.reference.read',
  'managers.post.forward',
  'managers.post.question',
  'managers.report.read',
  'managers.question.ask',
  'managers.question.forward',
])

export interface MockManagerHost
  extends Pick<MockTasksHost, 'clock' | 'lang' | 'devices' | 'device' | 'spawn'> {
  suggestions?(deviceId: string): readonly SuggestionView[]
  say(deviceId: string, threadId: string, prompt: string, answer: string): void
  add(deviceId: string, session: ManagerSessionSummary): void
  mark(deviceId: string, threadId: string, manager: ManagerView): void
  /** 发出结束事件并开始收尾回合；回合停止时由宿主调用 turnEnded。 */
  ending(deviceId: string, threadId: string, prompt: string, answer: string): string
}

export function createMockManagers(host: MockManagerHost) {
  const states = new Map<string, ReturnType<typeof sampleManagers>>()
  const histories = new Map<string, ReturnType<typeof sampleManagerHistory>>()
  const lists = new Map<string, Set<HostSink>>()
  const boards = new Map<string, Set<HostSink>>()
  const endingTurns = new Map<string, string>()
  let seq = 0
  const t = (zh: string, en: string) => (host.lang === 'zh-CN' ? zh : en)
  const available = (id: string) => {
    const device = host.device(id)
    return device?.mode !== 'full' ? false : device.stale ? null : true
  }
  /**
   * 设备服务比应用旧（远程升级那几出里的关键字把它变旧，mock-remote-upgrade.mts）就当成没宣告后加的经理能力，
   * 与真实设备里 0.28.1 及以前的服务一样：入口禁用、写明去设备详情升级，升级换上新版后恢复。
   */
  const features = (id: string): ManagerFeaturesView => {
    const version = host.device(id)?.service?.version
    const parts = (value: string) => value.split('.').map(Number)
    const [a = 0, b = 0, c = 0] = version ? parts(version) : []
    const [x = 0, y = 0, z = 0] = parts(SERVICE_VERSIONS.bundled)
    const old = version !== undefined && (a - x || b - y || c - z) < 0
    return { feedback: !old, posts: !old, ignore: !old }
  }
  const oldDevice = () =>
    new ChannelError(
      'unsupported',
      t(
        '设备服务版本较旧，不支持这个操作。请在设备详情里升级设备服务后再试。',
        'The device service is older than this app and does not support this action. Upgrade the device service in the device details, then try again.',
      ),
    )
  const state = (id: string) => {
    let value = states.get(id)
    if (!value) {
      value =
        available(id) === true
          ? sampleManagers(id, host.clock.now(), host.lang)
          : { managers: [], boards: [], sessions: [] }
      for (const board of value.boards) {
        if (board.managerId === 'm1') board.posts = [sampleReport(host.clock.now(), host.lang)]
        board.posts = mockPosts(board)
      }
      for (const manager of value.managers)
        manager.pendingReports =
          value.boards.find((b) => b.managerId === manager.id)?.posts?.filter((p) => p.unread)
            .length ?? 0
      states.set(id, value)
      for (const session of value.sessions) host.add(id, session)
      for (const manager of value.managers) {
        const board = value.boards.find((board) => board.managerId === manager.id)
        if (board)
          histories.set(key(id, manager.threadId), sampleManagerHistory(manager, board, host.lang))
      }
    }
    return value
  }
  const key = (deviceId: string, managerId: string) => JSON.stringify([deviceId, managerId])
  const boardView = (deviceId: string, managerId: string) => {
    const board = state(deviceId).boards.find((b) => b.managerId === managerId) ?? null
    if (board)
      board.posts = mockPosts(
        board,
        host.suggestions?.(deviceId).filter((s) => s.managerId === managerId) ?? [],
      )
    return {
      deviceId,
      managerId,
      available: available(deviceId),
      board,
      features: features(deviceId),
    }
  }
  const publish = (deviceId: string, manager: ManagerView, board: ManagerBoardView) => {
    manager.pendingDecisions = board.decisions.filter((d) => d.status === 'open').length
    manager.pendingRequests = (board.requests ?? []).filter((r) => r.status === 'open').length
    boardView(deviceId, manager.id)
    manager.pendingReports = board.posts?.filter((p) => p.unread).length ?? 0
    manager.pendingSuggestions =
      host
        .suggestions?.(deviceId)
        .filter((s) => s.managerId === manager.id && s.managerReview?.state === 'endorsed')
        .length ?? 0
    manager.latestActivity = board.activities[0] ?? null
    manager.updatedAt = host.clock.now()
    host.mark(deviceId, manager.threadId, manager)
    for (const sink of lists.get(deviceId) ?? [])
      sink.delta([{ op: 'manager.upsert', manager: copy(manager) }])
    for (const sink of boards.get(key(deviceId, manager.id)) ?? [])
      sink.delta([{ op: 'managerBoard.set', view: copy(boardView(deviceId, manager.id)) }])
  }
  const activity = (board: ManagerBoardView, text: string) =>
    board.activities.unshift({
      id: `mock-activity-${++seq}`,
      kind: 'manager',
      source: { kind: 'user' },
      at: host.clock.now(),
      text,
      objectId: null,
      threadId: null,
      changeId: null,
    })
  /**
   * 决策状态变化记一条变更（新的在前，同设备）：客户端靠它判断本地草稿能不能随重开恢复。
   * 只记状态、关闭记录和版本，模拟核心不需要完整前后值。
   */
  const statusChange = (
    board: ManagerBoardView,
    decision: ManagerDecisionView,
    apply: () => void,
    by: ManagerChangeView['by'],
    why: string,
  ) => {
    const pick = () => ({
      status: decision.status,
      closed: decision.closed,
      answer: decision.answer,
      revision: decision.revision,
    })
    const before = pick()
    apply()
    const after = pick()
    board.changes.unshift({
      id: `mock-change-${++seq}`,
      objectId: decision.id,
      by,
      at: host.clock.now(),
      fields: Object.keys(after).filter(
        (key) =>
          JSON.stringify(before[key as keyof typeof before]) !==
          JSON.stringify(after[key as keyof typeof after]),
      ),
      before,
      after,
      why,
    })
  }
  const run = async (name: string, params: unknown): Promise<unknown> => {
    const { deviceId } = params as { deviceId: string }
    const device = host.device(deviceId)
    if (!device) throw new ChannelError('notFound', t('设备不存在', 'Device not found'))
    if (device.stale) throw new ChannelError('offline', t('设备未连接', 'Device is offline'))
    if (!available(deviceId))
      throw new ChannelError(
        'unsupported',
        t('此设备不支持经理', 'This device does not support managers'),
      )
    // 与核心一致：没宣告的能力不发请求；只有决策答复的 feedback 照常（核心改走 answers/submit）
    const has = features(deviceId)
    const given = params as { questions?: unknown[]; requests?: unknown[] }
    if (
      (!has.posts && POSTS_COMMANDS.has(name)) ||
      (!has.ignore && name === 'managers.decision.ignore') ||
      (!has.feedback &&
        name === 'managers.feedback.submit' &&
        (given.questions?.length || given.requests?.length))
    )
      throw oldDevice()
    const data = state(deviceId)
    if (name === 'managers.create') {
      const { manager: draft } = params as Commands['managers.create']['params']
      if (!Number.isInteger(draft.dispatch.maxRunningLines) || draft.dispatch.maxRunningLines < 1)
        throw new ChannelError(
          'invalid',
          t('并行线数必须为正整数', 'The concurrent line limit must be a positive integer'),
        )
      const id = `manager-${++seq}`
      const threadId = host.spawn(deviceId, {
        harness: draft.harness,
        cwd: draft.cwd,
        workspaceId: null,
        title: draft.name || draft.scope,
        ...(draft.permission ? { permission: draft.permission } : {}),
      })
      const { firstTask, ...settings } = copy(draft)
      const manager: ManagerView = {
        ...settings,
        id,
        deviceId,
        threadId,
        status: 'active',
        pendingDecisions: 0,
        runningLines: 0,
        latestActivity: null,
        createdAt: host.clock.now(),
        updatedAt: host.clock.now(),
        endedAt: null,
      }
      const board: ManagerBoardView = {
        deviceId,
        managerId: id,
        situation: null,
        decisions: [],
        items: [],
        lines: [],
        activities: [],
        changes: [],
      }
      data.managers.push(manager)
      data.boards.push(board)
      host.say(
        deviceId,
        threadId,
        firstTask.trim() ? firstTask : sampleManagerOpening(manager, host.lang),
        t(
          '已建立看板，先整理计划，等待开始。',
          'The board is ready. I will organize the plan and wait to start.',
        ),
      )
      activity(board, t('经理已建立', 'Manager created'))
      publish(deviceId, manager, board)
      return { manager: copy(manager), threadId }
    }
    const { managerId } = params as { managerId: string }
    const manager = data.managers.find((m) => m.id === managerId)
    const board = data.boards.find((b) => b.managerId === managerId)
    if (!manager || !board) throw new ChannelError('notFound', t('经理不存在', 'Manager not found'))
    if (manager.status !== 'active')
      throw new ChannelError(
        'rejected',
        manager.status === 'ending'
          ? t('经理正在收尾，看板只读', 'The manager is wrapping up; the board is read-only')
          : t('经理已结束，看板只读', 'The manager has ended; the board is read-only'),
      )
    boardView(deviceId, managerId)
    if (name === 'managers.reference.read')
      return {
        text: 'commit a9a85c1\n\n    Manager console update\n\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Litch\n+Litch Console',
      }
    if (
      name === 'managers.post.forward' ||
      name === 'managers.report.read' ||
      name === 'managers.post.question'
    ) {
      const given = params as Commands['managers.post.question']['params']
      const post = board.posts?.find((p) => p.id === given.id)
      if (!post || (name !== 'managers.post.forward' && post.revision !== given.revision))
        throw new ChannelError('invalid', 'The post changed; review it again.')
      if (name === 'managers.post.forward') {
        post.discussion.forwarded = post.discussion.messages.length
        host.say(
          deviceId,
          manager.threadId,
          forwardedManagerQuestion(post.id, post.title, post.discussion),
          t('已收到追问记录。', 'Received the discussion.'),
        )
        publish(deviceId, manager, board)
        return { queued: true }
      }
      if (name === 'managers.report.read') {
        if (post.kind !== 'report') throw new ChannelError('invalid', 'Expected a report.')
        post.unread = false
      } else {
        if (!given.question?.trim()) throw new ChannelError('invalid', 'Question required.')
        // 让验收在回复到达前写下一份草稿，覆盖编辑中收到原帖修订和讨论记录的情况。
        if (given.question === '请稍后更新这项决策（验收）') {
          host.clock.setTimer(() => {
            const decision = board.decisions.find((entry) => entry.id === post.id)
            if (!decision) return
            decision.revision += 1
            decision.background += `\n\n异步补充背景 v${decision.revision}`
            decision.updatedAt = host.clock.now()
            post.discussion.messages.push({
              id: `post-question-${++seq}`,
              question: '',
              answer: '经理已更新决策，正在编辑的草稿应保留。',
              mode: 'manager',
              at: host.clock.now(),
              answeredAt: host.clock.now(),
              status: 'completed',
              refreshed: false,
            })
            publish(deviceId, manager, board)
          }, 1200)
        }
        post.discussion.messages.push({
          id: `post-question-${++seq}`,
          question: given.question,
          answer: t(
            '已核对这条内容。可以继续追问具体范围。',
            'I checked this post. You can ask about its specific scope.',
          ),
          mode: given.mode,
          at: host.clock.now(),
          answeredAt: host.clock.now(),
          status: 'completed',
          refreshed: false,
        })
        if (post.kind === 'decision') {
          const d = board.decisions.find((d) => d.id === post.id)
          if (d) {
            d.discussion = post.discussion
            // 隐藏窗口验收：临时追问更新决策，完整走看板增量和客户端草稿处理。
            if (given.mode === 'temporary' && given.question === '请更新这项决策的背景（验收）') {
              const before = copy(d) as unknown as Record<string, unknown>
              d.revision += 1
              d.background += `\n\n补充背景 v${d.revision}`
              d.updatedAt = host.clock.now()
              board.changes.unshift({
                id: `mock-change-${++seq}`,
                objectId: d.id,
                by: 'manager',
                at: host.clock.now(),
                fields: ['background', 'revision'],
                before,
                after: copy(d) as unknown as Record<string, unknown>,
                why: '追问后补充背景',
              })
            }
          }
        }
        if (given.mode === 'manager')
          host.say(
            deviceId,
            manager.threadId,
            formatSessionEvent({
              kind: 'manager-answers',
              notes: [],
              manager: {
                managerId,
                answers: [],
                postQuestions: [
                  {
                    id: post.id,
                    revision: post.revision,
                    title: post.title,
                    question: given.question,
                  },
                ],
                text: '',
              },
            }),
            t('已在帖子中回复。', 'Replied on the post.'),
          )
      }
      publish(deviceId, manager, board)
      return { post: copy(post) }
    }
    let result: unknown
    if (name === 'managers.update') {
      const { patch } = params as Commands['managers.update']['params']
      if (
        patch.dispatch &&
        (!Number.isInteger(patch.dispatch.maxRunningLines) || patch.dispatch.maxRunningLines < 1)
      )
        throw new ChannelError(
          'invalid',
          t('并行线数必须为正整数', 'The concurrent line limit must be a positive integer'),
        )
      const rulesChanged =
        (patch.scope !== undefined && patch.scope !== manager.scope) ||
        (patch.rules !== undefined && patch.rules !== manager.rules)
      Object.assign(manager, copy(patch))
      if (rulesChanged) {
        host.say(
          deviceId,
          manager.threadId,
          formatSessionEvent({
            kind: 'manager-rules',
            notes: [],
            manager: {
              managerId,
              text: [manager.scope, manager.rules].filter(Boolean).join('\n\n'),
            },
          }),
          t(
            '已更新经理设定，将按新设定安排工作。',
            'Manager settings updated; future work will follow the new instructions.',
          ),
        )
      }
      result = { manager }
    } else if (name === 'managers.reset.cancel') {
      if (manager.reset?.phase === 'waiting') manager.reset.phase = 'idle'
      else if (['summarizing', 'applying'].includes(manager.reset?.phase ?? ''))
        throw new ChannelError('busy', 'Manager reset is applying', phrase('manager.resetApplying'))
      result = { manager }
    } else if (name === 'managers.reset') {
      manager.reset = {
        mode: manager.reset?.mode ?? (manager.harness === 'claude-code' ? 'refresh' : 'replace'),
        current: 'mock-current',
        applied: 'mock-current',
        outdated: false,
        phase: 'ready',
      }
      result = { manager }
    } else if (name === 'managers.end') {
      manager.status = 'ending'
      activity(board, t('经理正在收尾', 'Manager is wrapping up'))
      const turnId = host.ending(
        deviceId,
        manager.threadId,
        formatSessionEvent({
          kind: 'manager-end',
          notes: [],
          manager: {
            managerId,
            text: t(
              '请整理总结，保留未完成事项。',
              'Summarize the work and preserve unfinished items.',
            ),
          },
        }),
        t(
          '本轮工作已结束，已整理工作结果，未完成事项和决策保留在看板上。',
          'This round has ended. The results are summarized, and unfinished items and decisions remain on the board.',
        ),
      )
      endingTurns.set(key(deviceId, manager.threadId), turnId)
      result = { manager }
    } else if (name === 'managers.question.ask' || name === 'managers.question.forward') {
      const { decisionId } = params as Commands['managers.question.forward']['params']
      const decision = board.decisions.find((entry) => entry.id === decisionId)
      if (!decision) throw new ChannelError('notFound', t('决策不存在', 'Decision not found'))
      const discussion = (decision.discussion ??= {
        messages: [],
        light: false,
        summary: null,
        forwarded: 0,
      })
      if (name === 'managers.question.ask') {
        const { question, revision } = params as Commands['managers.question.ask']['params']
        if (revision !== decision.revision || !question.trim())
          throw new ChannelError(
            'invalid',
            t('决策已变化或问题为空', 'Decision changed or question is empty'),
          )
        discussion.messages.push({
          id: `question-${discussion.messages.length + 1}`,
          question,
          answer: t(
            `这项决策的背景是：${decision.background}\n${discussion.messages.length ? '根据前一轮追问，' : ''}建议结合依据确认影响范围；不确定的部分可以转给经理核实。`,
            `The context is: ${decision.background}\n${discussion.messages.length ? 'Following up on your previous question, ' : ''}review the evidence to confirm the scope. Forward any uncertainty to the manager.`,
          ),
          status: 'completed',
          refreshed: false,
          at: host.clock.now(),
        })
        result = {}
      } else {
        const queued = discussion.messages.length > discussion.forwarded
        if (queued) {
          host.say(
            deviceId,
            manager.threadId,
            forwardedManagerQuestion(decisionId, decision.title, discussion),
            t(
              '已收到背景问答，将进一步核实。',
              'I received the background questions and will check further.',
            ),
          )
          discussion.forwarded = discussion.messages.length
        }
        result = { queued }
      }
    } else if (name === 'managers.decision.reopen') {
      const { decisionId } = params as Commands['managers.decision.reopen']['params']
      const decision = board.decisions.find((d) => d.id === decisionId)
      if (!decision) throw new ChannelError('notFound', t('决策不存在', 'Decision not found'))
      if (
        decision.status !== 'expired' &&
        decision.status !== 'withdrawn' &&
        decision.status !== 'ignored'
      )
        throw new ChannelError(
          'rejected',
          t('只能重开已关闭的决策', 'Only closed decisions can be reopened'),
        )
      // 真设备重开时清掉 closed，客户端从变更记录里找回；模拟核心直接留下。
      // 撤销自己的忽略不留“上次关闭”（同投影：ignored→open 不给 previousClosed）
      decision.previousClosed = decision.status === 'ignored' ? null : decision.closed
      decision.reopened = null
      statusChange(
        board,
        decision,
        () => {
          decision.status = 'open'
          decision.closed = null
          decision.revision++
        },
        'user',
        'Decision reopened',
      )
      decision.updatedAt = host.clock.now()
      activity(board, t(`你重开了 ${decisionId}`, `You reopened ${decisionId}`))
      result = { decision }
    } else if (name === 'managers.decision.ignore') {
      const { decisionId, revision, reason } =
        params as Commands['managers.decision.ignore']['params']
      const decision = board.decisions.find((d) => d.id === decisionId)
      if (!decision) throw new ChannelError('notFound', t('决策不存在', 'Decision not found'))
      if (decision.status !== 'open' || decision.revision !== revision)
        throw new ChannelError(
          'rejected',
          t('决策已变化，请刷新后再试', 'The decision changed; refresh and try again'),
        )
      statusChange(
        board,
        decision,
        () => {
          decision.status = 'ignored'
          decision.closed = { reason: reason?.trim() ?? '', by: 'user', at: host.clock.now() }
          decision.revision++
        },
        'user',
        'Decision ignored',
      )
      decision.previousClosed = null
      decision.reopened = null
      decision.updatedAt = host.clock.now()
      activity(board, t(`你忽略了 ${decisionId}`, `You ignored ${decisionId}`))
      result = { decision }
    } else {
      const {
        answers,
        questions = [],
        requests = [],
      } = params as Commands['managers.feedback.submit']['params']
      const submitted: Commands['managers.feedback.submit']['result'] = {
        accepted: [],
        rejected: [],
        acceptedQuestions: [],
        rejectedQuestions: [],
        acceptedRequests: [],
        rejectedRequests: [],
        delivery: 'none',
      }
      for (const entry of requests) {
        const request = board.requests?.find((one) => one.id === entry.requestId)
        if (
          !request ||
          request.revision !== entry.revision ||
          request.status === 'cancelled' ||
          (!entry.delivered && !entry.text.trim())
        ) {
          submitted.rejectedRequests.push({
            requestId: entry.requestId,
            code:
              request?.status === 'cancelled'
                ? 'requestCancelled'
                : request
                  ? 'requestConflict'
                  : 'unknownRequest',
            message: t('请核对最新请求', 'Review the current request'),
            request: request ? copy(request) : null,
          })
          continue
        }
        request.response = { delivered: entry.delivered, text: entry.text, at: host.clock.now() }
        request.status = entry.delivered ? 'delivered' : 'replied'
        request.revision++
        request.updatedAt = host.clock.now()
        submitted.acceptedRequests.push(request)
      }
      for (const question of questions) {
        const decision = board.decisions.find((one) => one.id === question.decisionId)
        if (
          !decision ||
          decision.revision !== question.revision ||
          !question.question.trim() ||
          questions.filter((one) => one.decisionId === question.decisionId).length !== 1
        ) {
          submitted.rejectedQuestions.push({
            decisionId: question.decisionId,
            code: decision ? 'decisionConflict' : 'unknownDecision',
            message: t('决策已变化，请核对后重交', 'Review the changed decision and resubmit.'),
            decision: decision ? copy(decision) : null,
          })
          continue
        }
        const discussion = (decision.discussion ??= {
          messages: [],
          light: false,
          summary: null,
          forwarded: 0,
        })
        discussion.messages.push({
          id: `manager-question-${discussion.messages.length + 1}`,
          mode: 'manager',
          question: question.question,
          answer: t(`经理回复：${decision.background}`, `Manager reply: ${decision.background}`),
          status: 'completed',
          refreshed: false,
          at: host.clock.now(),
        })
        submitted.acceptedQuestions.push(decision)
      }
      const seen = new Set<string>()
      for (const answer of answers) {
        const decision = board.decisions.find((d) => d.id === answer.decisionId)
        const duplicate = seen.has(answer.decisionId)
        seen.add(answer.decisionId)
        const code = !decision
          ? 'unknownDecision'
          : duplicate
            ? 'invalidAnswer'
            : decision.revision !== answer.revision
              ? 'decisionConflict'
              : (answer.optionId !== null &&
                    !decision.options.some((o) => o.id === answer.optionId)) ||
                  (answer.optionId === null && !answer.text.trim())
                ? 'invalidAnswer'
                : null
        if (code || !decision) {
          submitted.rejected.push({
            decisionId: answer.decisionId,
            code: code ?? 'unknownDecision',
            message: t(
              '决策已变化或答复无效，请核对后重交',
              'The decision changed or the answer is invalid. Review and resubmit.',
            ),
            decision: decision ? copy(decision) : null,
          })
          continue
        }
        statusChange(
          board,
          decision,
          () => {
            decision.answer = {
              optionId: answer.optionId,
              text: answer.text,
              by: 'user',
              at: host.clock.now(),
            }
            decision.status = 'answered'
            decision.closed = null
            decision.revision++
          },
          'user',
          'Board answer submitted',
        )
        decision.previousClosed = null
        decision.reopened = null
        decision.updatedAt = host.clock.now()
        submitted.accepted.push(decision)
      }
      for (const decision of submitted.acceptedQuestions) {
        decision.revision += 2
        decision.updatedAt = host.clock.now()
      }
      if (
        submitted.accepted.length ||
        submitted.acceptedQuestions.length ||
        submitted.acceptedRequests.length
      ) {
        submitted.delivery = 'queued'
        const text = t(
          `你在看板上答复了 ${submitted.accepted.length} 项决策`,
          `You answered ${submitted.accepted.length} decisions on the board`,
        )
        host.say(
          deviceId,
          manager.threadId,
          formatSessionEvent({
            kind: 'manager-answers',
            notes: [],
            manager: {
              managerId,
              text,
              requests: submitted.acceptedRequests.map((request) => ({
                requestId: request.id,
                revision: request.revision,
                title: request.title,
                buttonLabel: request.buttonLabel,
                delivered: request.response?.delivered ?? false,
                text: request.response?.text ?? '',
              })),
              questions: submitted.acceptedQuestions.map((decision) => ({
                decisionId: decision.id,
                revision: decision.revision,
                title: decision.title,
                question: questions.find((one) => one.decisionId === decision.id)?.question ?? '',
              })),
              answers: submitted.accepted.map((decision) => ({
                decisionId: decision.id,
                title: decision.title,
                optionId: decision.answer?.optionId ?? null,
                optionLabel:
                  decision.options.find((option) => option.id === decision.answer?.optionId)
                    ?.label ?? null,
                text: decision.answer?.text ?? '',
                ...(decision.discussion ? { discussion: decision.discussion } : {}),
              })),
            },
          }),
          t(
            '已收到答复，将据此安排后续工作。',
            'Answers received. I will use them to plan the next steps.',
          ),
        )
        activity(board, text)
      }
      result = submitted
    }
    publish(deviceId, manager, board)
    return copy(result)
  }
  for (const device of host.devices()) state(device.id)
  const readOnlyNote = (deviceId: string, threadId: string): string | null => {
    const manager = state(deviceId).managers.find((entry) => entry.threadId === threadId)
    if (!manager || manager.status === 'active') return null
    return manager.status === 'ending'
      ? t(
          '经理正在收尾，对话和看板只读',
          'The manager is wrapping up. Chat and board are read-only.',
        )
      : t('经理已结束，对话和看板只读', 'This manager has ended. Chat and board are read-only.')
  }
  return {
    /** 设备服务换了版本（变旧或升级换上）：重发看板，能力位跟着变 */
    refreshBoards(deviceId: string) {
      if (!states.has(deviceId)) return
      for (const manager of state(deviceId).managers)
        for (const sink of boards.get(key(deviceId, manager.id)) ?? [])
          sink.delta([{ op: 'managerBoard.set', view: copy(boardView(deviceId, manager.id)) }])
    },
    refreshSuggestions(deviceId: string) {
      for (const manager of state(deviceId).managers) {
        const board = boardView(deviceId, manager.id).board
        if (!board) continue
        manager.pendingSuggestions =
          host
            .suggestions?.(deviceId)
            .filter((s) => s.managerId === manager.id && s.managerReview?.state === 'endorsed')
            .length ?? 0
        for (const sink of lists.get(deviceId) ?? [])
          sink.delta([{ op: 'manager.upsert', manager: copy(manager) }])
        for (const sink of boards.get(key(deviceId, manager.id)) ?? [])
          sink.delta([{ op: 'managerBoard.set', view: copy(boardView(deviceId, manager.id)) }])
      }
    },
    readOnlyNote,
    history(deviceId: string, threadId: string) {
      const history = histories.get(key(deviceId, threadId))
      return history ? copy(history) : undefined
    },
    readOnly(deviceId: string, threadId: string): boolean {
      return readOnlyNote(deviceId, threadId) !== null
    },
    turnEnded(deviceId: string, threadId: string, turnId: string) {
      const id = key(deviceId, threadId)
      if (endingTurns.get(id) !== turnId) return
      endingTurns.delete(id)
      const data = state(deviceId)
      const manager = data.managers.find((entry) => entry.threadId === threadId)
      const board = data.boards.find((entry) => entry.managerId === manager?.id)
      if (!manager || !board) return
      manager.status = 'ended'
      manager.endedAt = host.clock.now()
      activity(board, t('经理已结束，看板只读', 'Manager ended; board is read-only'))
      publish(deviceId, manager, board)
    },
    subscribe(deviceId: string, sink: HostSink, managerId?: string) {
      const map = managerId === undefined ? lists : boards
      const id = managerId === undefined ? deviceId : key(deviceId, managerId)
      const sinks = map.get(id) ?? new Set<HostSink>()
      map.set(id, sinks)
      sinks.add(sink)
      sink.snapshot(
        copy(
          managerId === undefined
            ? { deviceId, available: available(deviceId), managers: state(deviceId).managers }
            : boardView(deviceId, managerId),
        ),
      )
      return () => {
        sinks.delete(sink)
      }
    },
    command(name: string, params: unknown): Promise<unknown> | undefined {
      return [
        'managers.reference.read',
        'managers.post.forward',
        'managers.post.question',
        'managers.report.read',
        'managers.create',
        'managers.update',
        'managers.end',
        'managers.reset',
        'managers.reset.cancel',
        'managers.answers.submit',
        'managers.feedback.submit',
        'managers.decision.reopen',
        'managers.decision.ignore',
        'managers.question.ask',
        'managers.question.forward',
      ].includes(name)
        ? run(name, params)
        : undefined
    },
  }
}
