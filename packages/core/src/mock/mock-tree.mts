// 模拟核心里的会话树：设备进程那一头（Litch 子会话、提案、回报与唤醒）和引擎自己的子代理线程，
// 都在这里假装出来，界面开发不等设备进程。会话树的规矩照 protocol/extensions/session-tree.json：
// - 对话里说“派子会话”（英文 spawn sub-sessions）：模型调两次 litch_sessions.start，派出两个子会话
//   （一个在 Pi 上，一个和父会话同一个 harness），父会话回一句就停下；子会话各自跑完一回合，
//   都停下之后替父会话开一个唤醒回合（<litch-session-event kind="wake">）；
// - 说“提个子会话”（propose a sub-session）：模型提三个提案（建议任务），第二个过一会儿就过期，
//   第三个在 Pi 上、沙箱收不紧；点“开始”（可以改了再开始）才起，点“不要”就了结；
// - 说“撤回提案”（withdraw a proposal）：模型撤回最近一个还等着的提案；
// - 说“收尾建议”（suggest follow-ups）：模型照规矩先调收尾（litch_sessions.wrap_up）、再写回答，带三条建议，
//   两条成了提案（第二条在 Pi 上），第三条简报太短被拒；还留了一个问题和两个回复按钮（回合结束才画出来）；
// - 提案卡上点“在这里做”：提案记 here，往这个会话发“在这里做：标题”加任务，回合在跑就等它结束再发；
// - 说“忘了收尾”（forget the wrap-up）：模型回答完没调收尾，设备进程替它再开一个回合提醒
//   （<litch-session-event kind="remind">），模型在那个回合里补调收尾、带一条建议；
// - 会话树的其余几出（派子会话、唤醒、提案、撤回）回答完都调一次空的收尾，界面上不画；
// - 说“新任务”（new task）：模型调 litch_sessions.start（initiation offer，只带标题），出“新会话 / 在这里做”的卡，
//   调用一直等着；选新会话：过一会儿模型用 accept 补上简报，起子会话，父会话回一句；选在这里做：模型在这里回答；
//   没选就停掉回合也算在这里做；
// - 说“交接”（hand off）：模型把手上做到一半的任务交给一个分叉会话（litch_sessions.hand_off，立刻起、不出卡），
//   再回答这条新消息；
// - 说“用子代理”（use sub-agents）：引擎自己派两个子代理线程（不进侧栏），一个能直接输入、一个不能，
//   它们回来之后父会话才接着说；
// - 界面上手动派（session.spawn）、脱离（session.detach）、提案的开始和不要、列子代理（session.agents）。
// 子会话的回报没被唤醒带走的，攒到父会话下一条用户消息前面（kind="notes"）。
import { CLIENT_TOOL_NAMESPACE, SESSION_TREE_LIMITS } from '../../../protocol/src/index.mjs'
import { ChannelError, type Commands, type SessionOp } from '../channel/protocol.mjs'
import type {
  HarnessView,
  OutgoingMessage,
  SessionAbilities,
  SessionSettings,
  SessionSummary,
  SessionView,
} from '../model.mjs'
import type {
  AgentThreadView,
  LineageKind,
  LineageOrigin,
  ProposalOverrides,
  SandboxLevel,
  SessionEventView,
  SessionNoteView,
  SessionProposalView,
} from '../model-tree.mjs'
import type { WorktreeFrom } from '../model-worktrees.mjs'
import { phrase } from '../phrase.mjs'
import { projectItem } from '../projection/items.mjs'
import { outgoing } from '../projection/outgoing.mjs'
import type { SampleLang } from './sample-text.mjs'
import {
  TREE_TEXT,
  type TreeAgent,
  type TreeProposal,
  type TreeSuggestion,
} from './sample-tree.mjs'

const SPAWNS = /派子会话|spawn sub-sessions/i
const PROPOSES = /提个子会话|propose a sub-session/i
const WITHDRAWS = /撤回提案|withdraw a proposal/i
const WRAPS = /收尾建议|suggest follow-ups/i
const FORGETS = /忘了收尾|forget the wrap-up/i
const OFFERS = /新任务|new task/i
const HANDS = /交接|hand off/i

/** offer 卡上选了新会话之后，模型过多久补上简报（按模拟的时钟） */
const BRIEF_MS = 900

/** 沙箱档对应的内置权限预设（模拟的子会话用它显示权限） */
const PRESET_OF: Record<SandboxLevel, string> = {
  'read-only': ':read-only',
  'workspace-write': ':workspace',
  'danger-full-access': ':danger-full-access',
}
const USES_AGENTS = /用子代理|use sub-agents/i

/** 演示里失败的子代理过多久失败、只剩要停掉的子代理时父会话过多久停掉它（按模拟的时钟） */
const AGENT_FAIL_MS = 600
const AGENT_STOP_MS = 2500

/** 第二个提案多久过期（按模拟的时钟）。真的是 7 天，这里要来得及看它收掉 */
const SHORT_PROPOSAL_MS = 8000

export interface MockTreeHost {
  lang: SampleLang
  now(): number
  setTimer(run: () => void, ms: number): () => void
  /** 侧栏里的一个会话。没有是 undefined */
  summary(deviceId: string, sessionId: string): SessionSummary | undefined
  /** 这台设备侧栏里所有的会话 */
  summaries(deviceId: string): SessionSummary[]
  /** 往侧栏里加一个会话并告诉订阅者 */
  addSummary(deviceId: string, summary: SessionSummary): void
  updateSummary(deviceId: string, sessionId: string, patch: Partial<SessionSummary>): void
  /** 载入（或者拿已经载入的）一个会话的内容 */
  view(deviceId: string, sessionId: string): SessionView
  /** 放进一个新会话的内容 */
  putView(view: SessionView): void
  apply(view: SessionView, ops: SessionOp[]): void
  /** 开一个回合：发一条消息（event 是注入在它开头的那一段）。返回回合的标识 */
  startTurn(view: SessionView, message: OutgoingMessage, event?: SessionEventView): string
  /** 在回合里流出一段回答，流完回合结束。tail：流完、回合结束之前再加的条目 */
  reply(view: SessionView, turnId: string, text: string, tail?: () => SessionOp[]): void
  /** 加上这几条就结束回合（没有回答的回合：提醒之后只补调收尾） */
  finish(view: SessionView, turnId: string, ops: SessionOp[]): void
  /** 回合失败，error 是给人看的原因 */
  fail(view: SessionView, turnId: string, error: string): void
  /** 回合还在跑的话打断它（和用户点停止一样收尾） */
  stop(view: SessionView, turnId: string): void
  running(view: SessionView): boolean
  /** 把一条话放进输入队列（回合结束后照常发） */
  enqueue(view: SessionView, message: OutgoingMessage): void
  /** 这台设备有没有会话树（DeviceView.sessionTree） */
  treeOn(deviceId: string): boolean
  harnesses(deviceId: string): HarnessView[]
  settings(deviceId: string, harness: string): SessionSettings
  can(deviceId: string, harness: string): SessionAbilities
  nextId(prefix: string): string
  /** 子会话要自己的工作树：建好后记成主人、目录换过去（建要一会儿，mock-worktrees.mts） */
  childWorktree(
    deviceId: string,
    sessionId: string,
    cwd: string,
    from: WorktreeFrom,
    title: string,
  ): void
}

interface AgentEntry {
  deviceId: string
  parentId: string
  /** 派出它的那个子代理调用：父会话的哪个回合、哪个条目 */
  turnId: string
  itemId: string
  spec: TreeAgent
  view: SessionView
  /** 结束了的话是怎么结束的；还在跑是 null */
  done: 'completed' | 'interrupted' | 'failed' | null
}

export interface MockTree {
  /** 这条消息是不是会话树的一出：是的话由这里接着演，返回 true */
  claim(view: SessionView, turnId: string, message: OutgoingMessage): boolean
  /** 一个回合停了（排着的消息接着发之前）：等着选的 offer 卡当在这里做（和设备进程一样） */
  turnStopped(view: SessionView): void
  /** 一个回合结束了：子会话的话记一条回报，看要不要唤醒父会话；子代理的话看父会话能不能接着说 */
  ended(view: SessionView, status: 'completed' | 'interrupted' | 'failed'): void
  /** 用户发的一条消息：攒着的回报附在它前面，唤醒的次数从头算 */
  notesFor(view: SessionView): SessionEventView | undefined
  /** 引擎自己的子代理线程的内容。不是子代理是 undefined */
  agentView(deviceId: string, sessionId: string): SessionView | undefined
  command(name: string, params: unknown): unknown
}

const sameKey = (deviceId: string, sessionId: string): string => `${deviceId}:${sessionId}`

export function createMockTree(host: MockTreeHost): MockTree {
  const text = TREE_TEXT[host.lang]
  /** 父会话 → 攒着的回报（同一个子会话后来的盖掉先前的） */
  const pending = new Map<string, SessionNoteView[]>()
  /** 父会话 → 上一条用户消息之后唤醒了几次 */
  const wakes = new Map<string, number>()
  /** 子会话 → 它要回的话（演示里写好的）。没有的照模拟核心平常那样回 */
  const scripted = new Map<string, string>()
  /** 引擎自己的子代理线程 */
  const agents = new Map<string, AgentEntry>()
  /** 回合开始时不回话的子代理（演示里失败的、要停掉的） */
  const held = new Set<string>()
  /** 这一回合模型没调收尾的会话：回合结束后替它开一个提醒的回合 */
  const unwrapped = new Set<string>()
  /** 点了“在这里做”发出去的话：模型照示例回一句 */
  const hereTexts = new Set<string>()

  /** 往会话里发“在这里做”的那条话：同真的核心，当用户的话进输入队列，回合在跑就排到回合结束后 */
  const sendHere = (view: SessionView, message: string) => {
    hereTexts.add(message)
    if (host.running(view) || view.queued.length > 0) host.enqueue(view, outgoing(message))
    else host.startTurn(view, outgoing(message))
  }

  const deviceHarness = (deviceId: string, wanted: string | null, fallback: string): string => {
    const ready = host.harnesses(deviceId).filter((entry) => entry.state === 'ready')
    if (wanted && ready.some((entry) => entry.id === wanted)) return wanted
    return fallback
  }

  /** 父会话是谁、标题是什么，写进子会话的第一段话；有背景的先放背景再放任务 */
  const briefOf = (parent: SessionView, prompt: string, background = ''): string => {
    const title = host.summary(parent.deviceId, parent.sessionId)?.title ?? parent.title
    const name = typeof title === 'string' ? title : parent.sessionId
    const head = text.briefHead.replace('{parent}', name)
    const context = background.trim()
    return context ? `${head}\n\nBackground:\n${context}\n\n${prompt}` : `${head}\n\n${prompt}`
  }

  /** 起一个子会话：放进侧栏（带着父子关系），发第一段话 */
  const startChild = (
    parent: SessionView,
    options: {
      title: string
      prompt: string
      /** 任务之前的背景（fresh 才放） */
      background?: string
      harness: string | null
      kind: LineageKind
      origin: LineageOrigin
      wakeParent: boolean
      reply: string | null
      settings?: Partial<SessionSettings>
      workspaceId?: string
      cwd?: string
      proposalId?: string
      /** 要不要自己的工作树；不给照缺省（父会话在工作树里就开） */
      worktree?: boolean | null
    },
  ): string => {
    const { deviceId } = parent
    const harness = deviceHarness(deviceId, options.harness, parent.harness)
    if (options.kind === 'fork' && harness !== parent.harness) {
      throw new ChannelError('rejected', '带着上下文派出的子会话只能和父会话同一个 harness')
    }
    const live = host
      .summaries(deviceId)
      .filter(
        (entry) =>
          entry.lineage?.parentId === parent.sessionId &&
          (entry.status === 'running' || entry.status === 'waiting'),
      )
    if (live.length >= SESSION_TREE_LIMITS.liveChildren) {
      throw new ChannelError('rejected', '这个会话同时在跑的子会话太多了')
    }
    const parentSummary = host.summary(deviceId, parent.sessionId)
    const now = host.now()
    const summary: SessionSummary = {
      id: host.nextId('c'),
      workspaceId: options.workspaceId ?? parentSummary?.workspaceId ?? null,
      harness,
      title: options.title,
      status: 'idle',
      waitingFor: null,
      unread: false,
      updatedAt: now,
      cwd: options.cwd ?? parent.cwd,
      pinned: false,
      section: null,
      placedAt: null,
      task: null,
      lineage: {
        parentId: parent.sessionId,
        kind: options.kind,
        origin: options.origin,
        title: options.title,
        wakeParent: options.wakeParent,
        createdAt: now,
        proposalId: options.proposalId ?? null,
      },
      nativeLineage: null,
      background: null,
      worktree: null,
    }
    host.addSummary(deviceId, summary)
    // 和设备进程一样：明说的照办，没说的父会话在工作树里（另给了目录的不算）就开新的，从父会话的分支切
    const hostTree = options.cwd ? null : (parentSummary?.worktree ?? null)
    if (options.worktree ?? hostTree !== null)
      host.childWorktree(
        deviceId,
        summary.id,
        // 模拟里只有工作区根算仓库：父会话在工作树里时从它的源仓库建
        hostTree ? hostTree.sourceRoot : summary.cwd,
        hostTree ? { kind: 'branch', branch: hostTree.branch } : { kind: 'head' },
        options.title,
      )
    // fork：带着父会话到现在为止的全部内容
    const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const view: SessionView = {
      deviceId,
      sessionId: summary.id,
      title: summary.title,
      harness,
      cwd: summary.cwd,
      live: true,
      note: null,
      turns: options.kind === 'fork' ? copy(parent.turns) : [],
      items: options.kind === 'fork' ? copy(parent.items) : {},
      requests: [],
      queued: [],
      settings: { ...host.settings(deviceId, harness), ...options.settings },
      usage: null,
      can: host.can(deviceId, harness),
      forkedFrom: null,
      proposals: [],
      agents: [],
    }
    host.putView(view)
    if (options.reply) scripted.set(sameKey(deviceId, summary.id), options.reply)
    const background = options.kind === 'fresh' ? (options.background ?? '') : ''
    host.startTurn(view, outgoing(briefOf(parent, options.prompt, background)))
    return summary.id
  }

  /**
   * 模型调了一次 litch_sessions 的工具：对话里那一条工具调用（经真的投影，start 画成派出卡片或提案卡片）
   */
  const sessionsCall = (
    turnId: string,
    args: Record<string, unknown>,
    /** null：调用还在等（offer 卡等用户选） */
    result: Record<string, unknown> | null,
    tool: 'start' | 'withdraw' | 'wrap_up' | 'accept' | 'hand_off' = 'start',
    id = host.nextId('ls'),
  ): SessionOp => ({
    op: 'item.add',
    turnId,
    item: projectItem({
      type: 'dynamicToolCall',
      id,
      namespace: CLIENT_TOOL_NAMESPACE.sessions,
      tool,
      arguments: args,
      status: result ? 'completed' : 'inProgress',
      contentItems: result ? [{ type: 'inputText', text: JSON.stringify(result) }] : null,
      success: result ? true : null,
      durationMs: result ? 40 : null,
    } as never),
  })

  const spawnDemo = (view: SessionView, turnId: string) => {
    const ops: SessionOp[] = []
    text.children.forEach((child, index) => {
      // 第一个放在 Pi 上（跨 harness 只能 fresh），第二个和父会话同一个 harness
      const harness = index === 0 ? 'pi' : view.harness
      const threadId = startChild(view, {
        title: child.title,
        prompt: child.prompt,
        harness,
        kind: 'fresh',
        origin: 'model',
        wakeParent: true,
        reply: child.reply,
      })
      ops.push(
        sessionsCall(
          turnId,
          {
            title: child.title,
            prompt: child.prompt,
            harness,
            initiation: 'user_asked',
          },
          { thread_id: threadId, note: 'Started.' },
        ),
      )
    })
    host.apply(view, ops)
    host.reply(view, turnId, text.spawnReply, emptyWrapUp(turnId))
  }

  const setProposals = (view: SessionView, proposals: SessionProposalView[]) =>
    host.apply(view, [{ op: 'session.proposals', proposals }])

  /**
   * 提案了结了（开始、不要、撤回、过期，offer 卡上选了）：和设备进程一样记下状态和时间，留在列表里。
   * offer 卡选了新会话（chosen）还没了结，不记时间
   */
  const settle = (
    view: SessionView,
    id: string,
    status: Exclude<SessionProposalView['status'], 'pending'>,
    startedId: string | null = null,
    settledAt: number | null = status === 'chosen' ? null : host.now(),
  ) =>
    setProposals(
      view,
      view.proposals.map((entry) =>
        entry.id === id ? { ...entry, status, settledAt, startedId } : entry,
      ),
    )

  /** 提案卡上工作树开关的初值：会话在设备层工作树里、提案没另给目录 */
  const inWorktree = (view: SessionView, sample?: { cwd?: string }) =>
    !sample?.cwd && host.summary(view.deviceId, view.sessionId)?.worktree != null

  /** 还等着、没过期的那一个 */
  const waiting = (view: SessionView, id: string): SessionProposalView | undefined =>
    view.proposals.find(
      (entry) => entry.id === id && entry.status === 'pending' && entry.expiresAt > host.now(),
    )

  /** 照示例记一张等着的提案（和设备进程一样记下提出它的回合和调用），开始之后子会话照示例回话 */
  const newProposal = (
    sample: TreeProposal,
    turnId: string,
    callId: string,
    createdAt: number,
    fallback: boolean,
  ): SessionProposalView => {
    const proposal: SessionProposalView = {
      id: host.nextId('pr'),
      title: sample.title,
      prompt: sample.prompt,
      background: sample.background ?? '',
      harness: sample.harness ?? null,
      model: null,
      effort: null,
      cwd: sample.cwd ?? null,
      kind: 'fresh',
      wakeParent: true,
      offer: false,
      status: 'pending',
      createdAt,
      expiresAt: sample.short
        ? host.now() + SHORT_PROPOSAL_MS
        : host.now() + SESSION_TREE_LIMITS.proposalTtlSeconds * 1000,
      settledAt: null,
      startedId: null,
      turnId,
      callId,
      widerSandbox: sample.widerSandbox ?? null,
      worktree: null,
      worktreeDefault: fallback,
    }
    scripted.set(`proposal:${proposal.id}`, sample.reply)
    return proposal
  }

  /** 空的收尾（这一回合没有建议）：回答流完、回合结束前调一次，界面上不画 */
  const emptyWrapUp = (turnId: string) => (): SessionOp[] => [
    sessionsCall(
      turnId,
      { suggestions: [] },
      { suggestions: [], note: 'No suggestions this turn.' },
      'wrap_up',
    ),
  ]

  /**
   * 收尾带了建议：收下的每条成一张提案（callId 都是这次调用的条目），被拒的照设备进程那样写原因。
   * 提案列表在调用的那一刻取（tail 里叫），接在手上那一份后面
   */
  const wrapUpOps = (
    view: SessionView,
    turnId: string,
    samples: readonly TreeSuggestion[],
    ask?: { ask: string; actions: readonly { label: string; message?: string }[] },
  ): SessionOp[] => {
    const now = host.now()
    const callId = host.nextId('ls')
    const made: SessionProposalView[] = []
    const results = samples.map((sample, index) => {
      if (sample.refused) return { title: sample.title, refused: sample.refused }
      const proposal = newProposal(sample, turnId, callId, now + index, inWorktree(view, sample))
      made.push(proposal)
      return { title: sample.title, proposal_id: proposal.id }
    })
    return [
      sessionsCall(
        turnId,
        {
          suggestions: samples.map((sample) => ({
            title: sample.title,
            prompt: sample.prompt,
            ...(sample.background ? { background: sample.background } : {}),
            ...(sample.harness ? { harness: sample.harness } : {}),
            ...(sample.cwd ? { cwd: sample.cwd } : {}),
          })),
          ...(ask ? { ask: ask.ask, actions: ask.actions } : {}),
        },
        { suggestions: results, note: 'Suggested; waiting for the user.' },
        'wrap_up',
        callId,
      ),
      { op: 'session.proposals', proposals: [...view.proposals, ...made] },
    ]
  }

  /** 回答完调收尾，带三条建议（第三条被拒） */
  const wrapDemo = (view: SessionView, turnId: string) => {
    // 照规矩先收尾、再写最终回答
    host.apply(
      view,
      wrapUpOps(view, turnId, text.wrapUp, { ask: text.wrapAsk, actions: text.wrapActions }),
    )
    host.reply(view, turnId, text.wrapReply)
  }

  /** 回答完没调收尾：记下来，回合结束后替它开一个提醒的回合（ended） */
  const forgetDemo = (view: SessionView, turnId: string) => {
    unwrapped.add(sameKey(view.deviceId, view.sessionId))
    host.reply(view, turnId, text.forgetReply)
  }

  const proposeDemo = (view: SessionView, turnId: string) => {
    const now = host.now()
    const made = text.proposals.map((sample, index) =>
      newProposal(sample, turnId, host.nextId('ls'), now + index, inWorktree(view, sample)),
    )
    host.apply(view, [
      ...made.map((proposal) =>
        sessionsCall(
          turnId,
          {
            title: proposal.title,
            prompt: proposal.prompt,
            ...(proposal.background ? { background: proposal.background } : {}),
            initiation: 'propose',
            ...(proposal.harness ? { harness: proposal.harness } : {}),
            ...(proposal.cwd ? { cwd: proposal.cwd } : {}),
          },
          { proposal_id: proposal.id, note: 'Proposed; waiting for the user.' },
          'start',
          proposal.callId ?? undefined,
        ),
      ),
      { op: 'session.proposals', proposals: [...view.proposals, ...made] },
    ])
    // 和设备进程一样：过期的那一刻记成过期、发一次通知
    for (const proposal of made) {
      host.setTimer(() => {
        if (view.proposals.find((entry) => entry.id === proposal.id)?.status !== 'pending') return
        settle(view, proposal.id, 'expired', null, proposal.expiresAt)
      }, proposal.expiresAt - now)
    }
    host.reply(view, turnId, text.proposeReply, emptyWrapUp(turnId))
  }

  /** 模型撤回最近提的、还等着的那一个提案（litch_sessions.withdraw） */
  const withdrawDemo = (view: SessionView, turnId: string) => {
    const target = view.proposals.filter((entry) => waiting(view, entry.id) !== undefined).at(-1)
    if (!target) {
      host.reply(view, turnId, text.withdrawNone, emptyWrapUp(turnId))
      return
    }
    host.apply(view, [
      sessionsCall(
        turnId,
        { proposal_id: target.id },
        { status: 'withdrawn', note: 'Withdrawn.' },
        'withdraw',
      ),
    ])
    scripted.delete(`proposal:${target.id}`)
    settle(view, target.id, 'withdrawn')
    host.reply(view, turnId, text.withdrawReply, emptyWrapUp(turnId))
  }

  /** 等着用户选的 offer 卡：提案号 → 提出它的会话、回合、那次 start 调用 */
  const offers = new Map<string, { view: SessionView; turnId: string; callId: string }>()

  /** 模型出一张 offer 卡（只带标题），那次 start 调用一直等着，回合也不结束 */
  const offerDemo = (view: SessionView, turnId: string) => {
    const callId = host.nextId('ls')
    const now = host.now()
    const proposal: SessionProposalView = {
      id: host.nextId('pr'),
      title: text.offer.title,
      prompt: '',
      background: '',
      harness: null,
      model: null,
      effort: null,
      cwd: null,
      kind: 'fresh',
      wakeParent: true,
      offer: true,
      status: 'offered',
      createdAt: now,
      expiresAt: now + SESSION_TREE_LIMITS.proposalTtlSeconds * 1000,
      settledAt: null,
      startedId: null,
      turnId,
      callId,
      widerSandbox: null,
      worktree: null,
      worktreeDefault: inWorktree(view),
    }
    offers.set(proposal.id, { view, turnId, callId })
    host.apply(view, [
      sessionsCall(turnId, { title: proposal.title, initiation: 'offer' }, null, 'start', callId),
      { op: 'session.proposals', proposals: [...view.proposals, proposal] },
    ])
  }

  /**
   * offer 卡有了答复：等着的那次 start 调用拿到结果。选了新会话，过一会儿模型用 accept 补上简报、起子会话；
   * 选了在这里做（或者没选就停了回合），模型在这里接着做
   */
  const answerOffer = (
    proposalId: string,
    choice: 'session' | 'here',
    stopped = false,
    worktree?: boolean,
  ) => {
    const offer = offers.get(proposalId)
    if (!offer) return
    offers.delete(proposalId)
    const { view, turnId, callId } = offer
    const note =
      choice === 'session'
        ? 'The user chose a new session. Call accept with this proposal_id and the full brief.'
        : 'The user chose to do it here. Do the task in this session.'
    settle(view, proposalId, choice === 'session' ? 'chosen' : 'here')
    host.apply(view, [
      sessionsCall(
        turnId,
        { title: text.offer.title, initiation: 'offer' },
        { proposal_id: proposalId, choice, note },
        'start',
        callId,
      ),
    ])
    if (stopped) return
    if (choice === 'here') {
      host.reply(view, turnId, text.offerHereReply, emptyWrapUp(turnId))
      return
    }
    host.setTimer(() => {
      if (!host.running(view)) return
      const sessionId = startChild(view, {
        title: text.offer.title,
        prompt: text.offer.prompt,
        background: text.offer.background ?? '',
        harness: null,
        kind: 'fresh',
        origin: 'proposal',
        wakeParent: true,
        reply: text.offer.reply,
        proposalId,
        worktree: worktree ?? null,
      })
      setProposals(
        view,
        view.proposals.map((entry) =>
          entry.id === proposalId
            ? {
                ...entry,
                prompt: text.offer.prompt,
                background: text.offer.background ?? '',
                status: 'started',
                settledAt: host.now(),
                startedId: sessionId,
              }
            : entry,
        ),
      )
      host.apply(view, [
        sessionsCall(
          turnId,
          {
            proposal_id: proposalId,
            prompt: text.offer.prompt,
            ...(text.offer.background ? { background: text.offer.background } : {}),
          },
          { thread_id: sessionId, note: 'Started.' },
          'accept',
        ),
      ])
      host.reply(view, turnId, text.offerStartedReply, emptyWrapUp(turnId))
    }, BRIEF_MS)
  }

  /** 模型把做到一半的任务交给一个分叉会话（立刻起，不出卡），再回答这条新消息 */
  const handOffDemo = (view: SessionView, turnId: string) => {
    const sessionId = startChild(view, {
      title: text.handOff.title,
      prompt: text.handOff.prompt,
      harness: view.harness,
      kind: 'fork',
      origin: 'model',
      wakeParent: true,
      reply: text.handOff.reply,
    })
    host.apply(view, [
      sessionsCall(
        turnId,
        { title: text.handOff.title, remaining_plan: text.handOff.prompt },
        { thread_id: sessionId, note: 'Handed off; the forked session is running.' },
        'hand_off',
      ),
    ])
    host.reply(view, turnId, text.handOffReply, emptyWrapUp(turnId))
  }

  /** 提案开始：照提案起子会话，改过的那几项照改的 */
  const acceptProposal = (
    view: SessionView,
    proposal: SessionProposalView,
    overrides: ProposalOverrides,
  ): string => {
    const reply = scripted.get(`proposal:${proposal.id}`) ?? null
    const sessionId = startChild(view, {
      title: overrides.title?.trim() || proposal.title,
      prompt: overrides.prompt?.trim() || proposal.prompt,
      background: overrides.background ?? proposal.background,
      harness: overrides.harness ?? proposal.harness,
      kind: overrides.kind ?? proposal.kind,
      origin: 'proposal',
      wakeParent: overrides.wakeParent ?? proposal.wakeParent,
      // 简报改过了，写好的那句回话就对不上了
      reply: overrides.prompt || overrides.background !== undefined ? null : reply,
      settings: {
        ...(overrides.model || proposal.model ? { model: overrides.model ?? proposal.model } : {}),
        ...(overrides.effort ? { effort: overrides.effort } : {}),
        ...(overrides.sandbox ? { permission: PRESET_OF[overrides.sandbox] } : {}),
      },
      ...(overrides.workspaceId ? { workspaceId: overrides.workspaceId } : {}),
      ...(overrides.cwd || proposal.cwd ? { cwd: overrides.cwd ?? proposal.cwd ?? '' } : {}),
      proposalId: proposal.id,
      worktree: overrides.worktree ?? proposal.worktree,
    })
    scripted.delete(`proposal:${proposal.id}`)
    settle(view, proposal.id, 'started', sessionId)
    return sessionId
  }

  /** 子代理结束的方式 → 协作条目里报的状态 */
  const AGENT_DONE = {
    completed: 'completed',
    interrupted: 'interrupted',
    failed: 'errored',
  } as const

  /**
   * 子代理调用的条目：经真的投影，界面画成一行一行的子代理。和真的 Claude 入口一样，派出的那一条结束时
   * 报的是“在跑”，之后不回写；子代理的状态以子线程自己的回合为准（session.agents），等待那一条报最后的状态
   */
  const collabItem = (
    id: string,
    tool: 'spawnAgent' | 'wait',
    status: 'inProgress' | 'completed',
    entries: AgentEntry[],
    parentId: string,
  ) =>
    projectItem({
      type: 'collabAgentToolCall',
      id,
      tool,
      status,
      senderThreadId: parentId,
      receiverThreadIds:
        status === 'inProgress' && tool === 'spawnAgent'
          ? []
          : entries.map((entry) => entry.view.sessionId),
      prompt: tool === 'spawnAgent' ? text.agentsPrompt : null,
      model: null,
      reasoningEffort: null,
      agentsStates:
        status === 'inProgress'
          ? {}
          : Object.fromEntries(
              entries.map((entry) => [
                entry.view.sessionId,
                {
                  status: entry.done ? AGENT_DONE[entry.done] : 'running',
                  message:
                    entry.done === 'completed'
                      ? entry.spec.reply
                      : entry.done === 'failed'
                        ? (entry.spec.error ?? null)
                        : null,
                },
              ]),
            ),
    } as never)

  /** 父会话的子代理列表（真的核心从设备记着的子线程和它们的回合算出来） */
  const agentList = (deviceId: string, parentId: string): AgentThreadView[] =>
    [...agents.values()]
      .filter((entry) => entry.deviceId === deviceId && entry.parentId === parentId)
      .map((entry) => {
        const turn = entry.view.turns.at(-1)
        return {
          id: entry.view.sessionId,
          parentId,
          nickname: entry.spec.nickname,
          role: entry.spec.role,
          description: entry.spec.description,
          prompt: entry.spec.prompt,
          status: host.running(entry.view) ? 'running' : 'idle',
          turn: turn
            ? {
                state:
                  turn.status === 'running'
                    ? 'running'
                    : turn.status === 'failed'
                      ? 'failed'
                      : turn.status === 'interrupted'
                        ? 'stopped'
                        : 'completed',
                startedAt: turn.startedAt,
                durationMs: turn.status === 'running' ? null : turn.durationMs,
                error: turn.error,
              }
            : null,
          canInput: entry.spec.canInput,
          updatedAt: turn?.startedAt ?? host.now(),
        } satisfies AgentThreadView
      })

  /** 子代理开始、结束了：父会话的子代理列表整份换掉 */
  const pushAgents = (deviceId: string, parentId: string) =>
    host.apply(host.view(deviceId, parentId), [
      { op: 'session.agents', agents: agentList(deviceId, parentId) },
    ])

  const agentsDemo = (view: SessionView, turnId: string) => {
    const itemId = host.nextId('ca')
    const made: AgentEntry[] = text.agents.map((spec) => {
      const id = host.nextId('ag')
      const agent: SessionView = {
        deviceId: view.deviceId,
        sessionId: id,
        title: spec.description,
        harness: view.harness,
        cwd: view.cwd,
        // 不接受直接输入的子代理只能看（真的核心照 canAcceptDirectInput 这样投影）
        live: spec.canInput,
        note: spec.canInput ? null : phrase('session.agentReadOnly'),
        turns: [],
        items: {},
        requests: [],
        queued: [],
        settings: host.settings(view.deviceId, view.harness),
        usage: null,
        can: host.can(view.deviceId, view.harness),
        forkedFrom: null,
        proposals: [],
        agents: [],
      }
      const entry: AgentEntry = {
        deviceId: view.deviceId,
        parentId: view.sessionId,
        turnId,
        itemId,
        spec,
        view: agent,
        done: null,
      }
      agents.set(sameKey(view.deviceId, id), entry)
      host.putView(agent)
      return entry
    })
    host.apply(view, [
      {
        op: 'item.add',
        turnId,
        item: collabItem(itemId, 'spawnAgent', 'inProgress', made, view.sessionId),
      },
    ])
    for (const entry of made) {
      const key = sameKey(entry.deviceId, entry.view.sessionId)
      // 完成的回一句话；失败的、要停掉的回合开始时不回话（claim 认下就不往下走）
      if (entry.spec.outcome === 'completed') scripted.set(key, entry.spec.reply)
      else held.add(key)
      const childTurn = host.startTurn(entry.view, outgoing(entry.spec.prompt))
      // 一开始就被拦下：过一小会儿失败，原因是 harness 的原话。stopped 的一直在跑，等别的都回来之后由父会话停掉
      if (entry.spec.outcome === 'failed')
        host.setTimer(() => host.fail(entry.view, childTurn, entry.spec.error ?? ''), AGENT_FAIL_MS)
    }
    host.apply(view, [
      {
        op: 'item.add',
        turnId,
        item: collabItem(itemId, 'spawnAgent', 'completed', made, view.sessionId),
      },
    ])
    pushAgents(view.deviceId, view.sessionId)
  }

  /** 同一次派出的子代理 */
  const siblingsOf = (entry: AgentEntry) =>
    [...agents.values()].filter(
      (other) => other.itemId === entry.itemId && other.deviceId === entry.deviceId,
    )

  /**
   * 父会话的一个子代理结束了：更新列表；只剩要停掉的那几个在跑时，过一会儿父会话停掉它们；
   * 都停下了，父会话报一次等待的结果，接着说
   */
  const agentDone = (entry: AgentEntry, status: 'completed' | 'interrupted' | 'failed') => {
    entry.done = status
    pushAgents(entry.deviceId, entry.parentId)
    const siblings = siblingsOf(entry)
    const left = siblings.filter((other) => !other.done)
    if (left.length > 0) {
      if (left.every((other) => other.spec.outcome === 'stopped'))
        host.setTimer(() => {
          for (const other of left) {
            const turn = other.view.turns.at(-1)
            if (turn) host.stop(other.view, turn.id)
          }
        }, AGENT_STOP_MS)
      return
    }
    const parent = host.view(entry.deviceId, entry.parentId)
    host.apply(parent, [
      {
        op: 'item.add',
        turnId: entry.turnId,
        item: collabItem(host.nextId('cw'), 'wait', 'completed', siblings, entry.parentId),
      },
    ])
    if (parent.turns.some((turn) => turn.id === entry.turnId && turn.status === 'running'))
      host.reply(parent, entry.turnId, text.agentsReply)
  }

  /** 父会话的直接子会话都停下了吗 */
  const childrenStopped = (deviceId: string, parentId: string): boolean =>
    host
      .summaries(deviceId)
      .filter((entry) => entry.lineage?.parentId === parentId)
      .every((entry) => entry.status !== 'running' && entry.status !== 'waiting')

  /** 唤醒的条件都满足了就替父会话开一个回合（决 271） */
  const tryWake = (deviceId: string, parentId: string) => {
    const key = sameKey(deviceId, parentId)
    const notes = pending.get(key) ?? []
    if (notes.length === 0) return
    if (!host.summary(deviceId, parentId)) return
    const parent = host.view(deviceId, parentId)
    if (host.running(parent) || parent.requests.length > 0) return
    if (!childrenStopped(deviceId, parentId)) return
    const wanted = host
      .summaries(deviceId)
      .some(
        (entry) =>
          entry.lineage?.parentId === parentId &&
          entry.lineage.wakeParent &&
          notes.some((note) => note.threadId === entry.id),
      )
    if (!wanted) return
    const count = wakes.get(key) ?? 0
    if (count >= SESSION_TREE_LIMITS.wakesPerUserMessage) return
    wakes.set(key, count + 1)
    pending.delete(key)
    // 唤醒的回合只有注入的那一段，没有用户自己的话（不过 outgoing 的空消息检查）
    host.startTurn(parent, { text: '', images: [], extras: [] }, { kind: 'wake', notes })
  }

  return {
    claim(view, turnId, message) {
      const key = sameKey(view.deviceId, view.sessionId)
      const user = view.items[view.turns.find((turn) => turn.id === turnId)?.itemIds[0] ?? '']
      if (user?.kind === 'userMessage' && user.event?.kind === 'wake') {
        host.reply(view, turnId, text.wakeReply, emptyWrapUp(turnId))
        return true
      }
      // 提醒的回合：模型不再回答，只补调收尾
      if (user?.kind === 'userMessage' && user.event?.kind === 'remind') {
        host.setTimer(
          () => host.finish(view, turnId, wrapUpOps(view, turnId, [text.remindSuggestion])),
          300,
        )
        return true
      }
      if (held.delete(key)) return true
      if (hereTexts.delete(message.text)) {
        host.reply(view, turnId, text.hereReply, emptyWrapUp(turnId))
        return true
      }
      const script = scripted.get(key)
      if (script !== undefined) {
        scripted.delete(key)
        host.reply(view, turnId, script)
        return true
      }
      if (USES_AGENTS.test(message.text)) {
        agentsDemo(view, turnId)
        return true
      }
      // Litch 子会话的两出要设备有会话树
      if (!host.treeOn(view.deviceId)) return false
      if (SPAWNS.test(message.text)) {
        spawnDemo(view, turnId)
        return true
      }
      if (PROPOSES.test(message.text)) {
        proposeDemo(view, turnId)
        return true
      }
      if (WITHDRAWS.test(message.text)) {
        withdrawDemo(view, turnId)
        return true
      }
      if (WRAPS.test(message.text)) {
        wrapDemo(view, turnId)
        return true
      }
      if (FORGETS.test(message.text)) {
        forgetDemo(view, turnId)
        return true
      }
      if (OFFERS.test(message.text)) {
        offerDemo(view, turnId)
        return true
      }
      if (HANDS.test(message.text)) {
        handOffDemo(view, turnId)
        return true
      }
      return false
    },

    turnStopped(view) {
      for (const [proposalId, offer] of offers)
        if (offer.view === view) answerOffer(proposalId, 'here', true)
    },

    ended(view, status) {
      const { deviceId, sessionId } = view
      const agent = agents.get(sameKey(deviceId, sessionId))
      if (agent) {
        if (!agent.done) agentDone(agent, status)
        return
      }
      const summary = host.summary(deviceId, sessionId)
      const lineage = summary?.lineage
      if (lineage) {
        // 回报：最后一条回答的开头
        const turn = view.turns.at(-1)
        const answer = [...(turn?.itemIds ?? [])]
          .reverse()
          .map((id) => view.items[id])
          .find((item) => item?.kind === 'agentMessage')
        const excerpt =
          answer?.kind === 'agentMessage'
            ? Array.from(answer.text).slice(0, SESSION_TREE_LIMITS.noteChars).join('')
            : ''
        const key = sameKey(deviceId, lineage.parentId)
        const notes = (pending.get(key) ?? []).filter((note) => note.threadId !== sessionId)
        notes.push({ threadId: sessionId, title: lineage.title, status, excerpt })
        pending.set(key, notes)
        tryWake(deviceId, lineage.parentId)
      }
      // 自己是父会话：刚停下，看看攒着的回报够不够唤醒自己
      tryWake(deviceId, sessionId)
      // 用户发起的回合没调收尾：替它开一个提醒的回合（一条用户消息之后最多一次）
      const key = sameKey(deviceId, sessionId)
      if (unwrapped.delete(key) && status === 'completed' && !host.running(view)) {
        host.startTurn(view, { text: '', images: [], extras: [] }, { kind: 'remind', notes: [] })
      }
    },

    notesFor(view) {
      const key = sameKey(view.deviceId, view.sessionId)
      wakes.delete(key)
      const notes = pending.get(key)
      if (!notes?.length) return undefined
      pending.delete(key)
      return { kind: 'notes', notes }
    },

    agentView(deviceId, sessionId) {
      return agents.get(sameKey(deviceId, sessionId))?.view
    },

    command(name, params) {
      if (
        name.startsWith('session.proposal.') ||
        name === 'session.spawn' ||
        name === 'session.detach'
      ) {
        const { deviceId } = params as { deviceId: string }
        if (!host.treeOn(deviceId)) {
          throw new ChannelError('unsupported', '这台设备没有会话树')
        }
      }
      if (name === 'session.spawn') {
        const { deviceId, parentId, ...rest } = params as Commands['session.spawn']['params']
        const parent = host.view(deviceId, parentId)
        const sessionId = startChild(parent, {
          title: rest.title.trim() || rest.prompt.split('\n')[0]?.slice(0, 40) || '…',
          prompt: rest.prompt,
          ...(rest.background ? { background: rest.background } : {}),
          harness: rest.harness ?? null,
          kind: rest.kind,
          origin: 'user',
          wakeParent: rest.wakeParent,
          reply: null,
          settings: {
            ...(rest.model ? { model: rest.model } : {}),
            ...(rest.effort ? { effort: rest.effort } : {}),
            ...(rest.sandbox ? { permission: PRESET_OF[rest.sandbox] } : {}),
          },
          ...(rest.workspaceId ? { workspaceId: rest.workspaceId } : {}),
          ...(rest.cwd ? { cwd: rest.cwd } : {}),
          worktree: rest.worktree ?? null,
        })
        return { sessionId }
      }
      if (name === 'session.detach') {
        const { deviceId, sessionId } = params as Commands['session.detach']['params']
        if (!host.summary(deviceId, sessionId)?.lineage) {
          throw new ChannelError('rejected', '这个会话不是子会话')
        }
        host.updateSummary(deviceId, sessionId, { lineage: null })
        return {}
      }
      if (name === 'session.proposal.accept' || name === 'session.proposal.dismiss') {
        const { deviceId, sessionId, proposalId, overrides } =
          params as Commands['session.proposal.accept']['params']
        const view = host.view(deviceId, sessionId)
        const proposal = waiting(view, proposalId)
        if (!proposal) throw new ChannelError('notFound', '这个提案已经不在了')
        if (name === 'session.proposal.dismiss') {
          scripted.delete(`proposal:${proposalId}`)
          settle(view, proposalId, 'dismissed')
          return {}
        }
        return { sessionId: acceptProposal(view, proposal, overrides ?? {}) }
      }
      if (name === 'session.proposal.here') {
        const { deviceId, sessionId, proposalId, lead } =
          params as Commands['session.proposal.here']['params']
        const view = host.view(deviceId, sessionId)
        const proposal = waiting(view, proposalId)
        if (!proposal) throw new ChannelError('notFound', '这个提案已经不在了')
        scripted.delete(`proposal:${proposalId}`)
        settle(view, proposalId, 'here')
        sendHere(view, `${lead ?? 'Do it here: '}${proposal.title}\n\n${proposal.prompt}`)
        return {}
      }
      if (name === 'session.proposal.answer') {
        const { deviceId, sessionId, proposalId, choice, worktree } =
          params as Commands['session.proposal.answer']['params']
        const view = host.view(deviceId, sessionId)
        const proposal = view.proposals.find((entry) => entry.id === proposalId)
        if (proposal?.status !== 'offered' || !offers.has(proposalId))
          throw new ChannelError('notFound', '这张卡已经选过了')
        answerOffer(proposalId, choice, false, worktree)
        return {}
      }
      if (name === 'session.agents') {
        const { deviceId, sessionId } = params as Commands['session.agents']['params']
        return { agents: agentList(deviceId, sessionId) }
      }
      return undefined
    },
  }
}
