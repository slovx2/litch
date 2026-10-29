import type { SessionPendingFields, SessionPendingRequest } from './session-pending.mjs'
// 会话树（扩展名 sessionTree）：一个会话派出的子会话、提案、回报与唤醒。父子关系存在设备进程自己的库里，
// 不存在任何引擎里；子会话本身是普通的顶层会话，照常出现在 thread/list 里，树由客户端按 litchLineage 搭。
// 引擎自己的子代理线程（标准协议的 parentThreadId、source.subAgent）不在这里，那是引擎的事。
// 定义的原文在仓库根目录 protocol/extensions/session-tree.json，模型用的工具在 client-tools-sessions.mts。
//
// 这个文件不引用别的文件：设备进程（packages/device）和客户端核心（packages/core）都直接引用它。

/** 子会话是怎么来的 */
export type SessionLineageKind =
  /** 只给了简报，任何 harness */
  | 'fresh'
  /** 带着主会话的全部上下文（引擎自己的 thread/fork），只能同 harness */
  | 'fork'

/** 谁起的 */
export type SessionLineageOrigin =
  /** 模型调 litch_sessions.start 直接起的（用户在这个回合里要求的） */
  | 'model'
  /** 模型提的提案，用户点了“开始” */
  | 'proposal'
  /** 用户在界面上派的（litch/session/start） */
  | 'user'

/**
 * 会话对象上的 `litchLineage`：只在声明了 sessionTree 的连接上、只在有父会话的会话上有。
 * 脱离之后（litch/session/detach）就没有了。
 */
export interface SessionLineage {
  /** 父会话（同一台设备上，可以是别的 harness） */
  parentThreadId: string
  kind: SessionLineageKind
  origin: SessionLineageOrigin
  /** 一行标题（派的时候给的） */
  title: string
  /** 子会话这一回合结束、全部子会话都停下时，要不要唤醒父会话 */
  wakeParent: boolean
  /** 建立父子关系的时间（秒） */
  createdAt: number
  /** origin 是 proposal 时：从哪个提案开始的（派出它的那张提案卡片据此显示“已开始”、能跳过来） */
  proposalId?: string
}

/** 会话对象上我们加的字段 */
export interface SessionTreeThreadFields extends SessionPendingFields {
  litchLineage?: SessionLineage
  /**
   * 会话建的时候带了哪些 `litch_` 命名空间的动态工具（设备进程记下的 thread/start.dynamicTools）。
   * 客户端据此知道这个会话里的模型能不能用 litch_sessions 读别的会话。只发给声明了 sessionTree 的连接；
   * 设备进程没记着的（不是经它建的、更早的设备进程）没有这个字段
   */
  litchToolNamespaces?: string[]
  /**
   * 排在这个会话的回报队列里、还没交给模型的子会话回报（每个子会话最新的一条，按进队列的先后）。
   * 只发给声明了 sessionTree 的连接，队列空着时没有这个字段；变了发 litch/thread/queuedNotes/updated
   */
  litchQueuedNotes?: SessionQueuedNote[]
}

/** 提案的状态 */
export type SessionProposalStatus =
  | 'pending'
  /** offer 卡：等用户选“新会话”还是“在这里做”（模型那次 start 调用一直等着） */
  | 'offered'
  /** offer 卡上用户选了新会话，等模型用 accept 补上简报开起来 */
  | 'chosen'
  /**
   * 在这里做：offer 卡上用户选了在这里做（或者没选就又发了话、回合被打断）；
   * 普通提案卡上用户点了“在这里做”（litch/sessionProposal/here）
   */
  | 'here'
  | 'started'
  /** 用户点了“不要” */
  | 'dismissed'
  /** 模型自己撤回了（litch_sessions.withdraw） */
  | 'withdrawn'
  | 'expired'

/** 模型提的“要不要另起一个子会话”，用户点了才起 */
export interface SessionProposal {
  id: string
  /** 提案挂在哪个会话上（就是将来的父会话） */
  threadId: string
  title: string
  /** 起子会话时发给它的任务 */
  prompt: string
  /**
   * 任务之前的背景：给没看过父会话的人看的整体目标、到目前为止的决定和约束、这一块怎么接上。
   * fresh 的模型提案都有；fork、用户在界面上派的、旧提案是空串。旧设备进程不带
   */
  background?: string
  /** 子会话的 harness。不给是父会话的 */
  harness: string | null
  model: string | null
  /** 推理强度。不给是开始那一刻父会话的（目标 harness 和父会话不同时是那边的默认）。旧设备进程不带 */
  effort?: string | null
  cwd: string | null
  kind: SessionLineageKind
  wakeParent: boolean
  status: SessionProposalStatus
  /**
   * offer 卡（litch_sessions.start 的 initiation offer）：只有标题，prompt 是空的，直到模型补上简报。旧设备进程不带。
   * 用户选了新会话、模型补的简报要开到收不紧沙箱的 harness 上时不开，降成带简报的 pending 提案：offer 仍为真、
   * 带 widerSandbox，卡上写明没直接开的原因，由用户看过再点。offer 为真又是 pending 的只有这一种
   */
  offer?: boolean
  createdAt: number
  /** 到这个时间（秒）还没点就过期 */
  expiresAt: number
  /** status 是 started 时，起出来的子会话 */
  startedThreadId: string | null
  /** 了结（开始、不要、撤回、过期）的时间（秒）；pending 时是 null。旧设备进程不带 */
  settledAt?: number | null
  /**
   * 提案是在父会话的哪个回合、哪次工具调用里提的（litch_sessions.start 那一条的 item id）：
   * 对话流里的卡片画在那一条上，侧面板的“建议任务”点了跳到那里。旧提案、拿不到时是 null，旧设备进程不带
   */
  turnId?: string | null
  callId?: string | null
  /**
   * 目标 harness 收不到父会话那么严时（它声明的权限预设里最严的一档也比父会话的沙箱宽，比如没有沙箱的 Pi），
   * 子会话实际会是的那一档沙箱：read-only、workspace-write、danger-full-access。收得紧时没有这个字段。
   * 模型这样派出时一律变成提案，提案卡片上要写明
   */
  widerSandbox?: string
  /**
   * 子会话要不要自己的工作树（worktrees 扩展）：模型明说的，或用户在 offer 卡上选新会话时定的；没定是 null。
   * 旧设备进程不带
   */
  worktree?: boolean | null
  /** 没人定时照缺省算出来的（父会话在 Litch 建的工作树里就是真），卡上开关的初值用 worktree ?? 它。旧设备进程不带 */
  worktreeDefault?: boolean
}

/** 上限（设备进程和界面按同一份） */
export const SESSION_TREE_LIMITS = {
  /** 回报取子会话最后一条回答的前多少字 */
  noteChars: 400,
  /** 提案多久过期（秒） */
  proposalTtlSeconds: 7 * 24 * 3600,
  /** 一条用户消息之后最多自动唤醒父会话几次 */
  wakesPerUserMessage: 10,
  /** 一个会话同时最多有几个没结束的子会话（直接子女） */
  liveChildren: 8,
  /** includeSettled 时最多列几条 */
  proposalListMax: 100,
} as const

// —— 客户端发起的方法（只在设备信息的 extensions 里列了 sessionTree 时可用） ——

export const SESSION_TREE_METHOD = {
  /** 用户在界面上派一个子会话。应答 SessionStartResponse */
  start: 'litch/session/start',
  /** 把一个子会话脱离成独立会话（去掉父子关系，会话本身不动）。应答空对象 */
  detach: 'litch/session/detach',
  /** 一个会话上的提案（缺省只列 pending 的，includeSettled 连了结的一起）。应答 SessionProposalListResponse */
  proposalList: 'litch/sessionProposal/list',
  /** 用户点“开始”（可以改 harness、模型、目录、简报等再开始）。参数 SessionProposalAcceptParams，应答 SessionStartResponse */
  proposalAccept: 'litch/sessionProposal/accept',
  /** 用户点“不要”。应答空对象 */
  proposalDismiss: 'litch/sessionProposal/dismiss',
  /** 用户在 offer 卡上选“新会话”或“在这里做”。参数 SessionProposalAnswerParams，应答空对象 */
  proposalAnswer: 'litch/sessionProposal/answer',
  /**
   * 用户在普通提案卡上点“在这里做”：提案记 here，设备进程往父会话发一条用户消息（标题加任务），
   * 父会话正在跑回合时排到回合结束后发。参数 SessionProposalHereParams，应答空对象
   */
  proposalHere: 'litch/sessionProposal/here',
  /**
   * 同上，但设备进程只了结提案、不发：那条消息（同 here 的写法）在应答里交回，由客户端放进自己的输入队列
   *（回合在跑时排到回合结束，同 Claude 桌面端；界面上看得见、能撤）。参数 SessionProposalHereParams，
   * 应答 SessionProposalMarkHereResult。旧的设备进程没有这个方法，客户端退回 here
   */
  proposalMarkHere: 'litch/sessionProposal/markHere',
  /**
   * 用户在排着的回报上点“立即处理”：父会话在跑就插进去，停着就替它开一个唤醒回合，不等别的子会话。
   * 参数 QueuedNotesDeliverParams，应答 QueuedNotesDeliverResponse。旧的设备进程没有这个方法
   */
  queuedNotesDeliver: 'litch/thread/queuedNotes/deliver',
} as const

/**
 * 设备设置里“任务卡”按 harness 的开关（作用域 harness，布尔，默认开）。关着时这个 harness 的会话：
 * 不带建议、offer 的规则，没有 wrap_up，不提醒收尾；已有会话的 wrap_up 建议不落提案、offer 直接当在这里做。
 * litch_sessions 其余能力照旧。整套会话编排仍由设备级的 sessions.enabled 管
 */
export const taskCardsSettingKey = (harness: string): string => `harness.${harness}.taskCards`

export const SESSION_TREE_NOTIFICATION = {
  /** 一个会话的父子关系变了（建立、脱离）。lineage 为 null 是没有父会话了 */
  lineageUpdated: 'litch/thread/lineage/updated',
  /** 一个会话上的提案变了（新提、开始、不要、撤回、过期）。带这个会话现在全部 pending 的提案，和刚变的那几条 */
  proposalChanged: 'litch/sessionProposal/changed',
  /** 一个会话的回报队列变了。带这个会话现在排着的全部回报 */
  queuedNotesUpdated: 'litch/thread/queuedNotes/updated',
} as const

/** `litch/session/start` 的参数 */
export interface SessionStartParams {
  parentThreadId: string
  /** 不给是父会话的 harness。kind 为 fork 时必须和父会话相同 */
  harness?: string
  model?: string
  effort?: string
  /** 不给是父会话的目录 */
  cwd?: string
  /** 设备级工作区（项目）。不给时跟父会话在同一个 */
  projectId?: string
  kind: SessionLineageKind
  title: string
  /** 发给子会话的任务 */
  prompt: string
  /** 任务之前的背景（fresh 时放在任务前面单成一段；fork 不用）。可以不给 */
  background?: string
  wakeParent: boolean
  /** 审批策略、沙箱：给了也会被收紧到不宽于父会话 */
  approvalPolicy?: string
  sandbox?: string
  /** 子会话要不要自己的工作树（设备列了 worktrees 才认）。不给照缺省：父会话在 Litch 建的工作树里就开新的 */
  worktree?: boolean
}

export interface SessionStartResponse {
  /** 起出来的子会话（会话对象上带着 litchLineage） */
  threadId: string
}

export interface SessionDetachParams {
  threadId: string
}

export interface SessionProposalListParams {
  threadId: string
  /** 连了结的一起列（新的在前，最多 proposalListMax 条） */
  includeSettled?: boolean
}

export interface SessionProposalListResponse {
  proposals: SessionProposal[]
}

export interface SessionProposalIdParams {
  proposalId: string
  /**
   * 提案所属的会话（客户端在哪个会话的卡上点的）。给了的话设备进程核对，不是这个会话的提案回 -32602；
   * 不给不核对（旧客户端）。旧设备进程不认这个字段、照旧只看 proposalId
   */
  threadId?: string
}

/** 用户从卡片开始时改的东西。不给的照提案里的；和 litch/session/start 一样，沙箱收紧到不宽于父会话 */
export interface SessionProposalOverrides {
  harness?: string
  model?: string
  effort?: string
  cwd?: string
  projectId?: string
  /** 改成 fork 时 harness 必须和父会话相同 */
  kind?: SessionLineageKind
  title?: string
  prompt?: string
  /** 空字符串是去掉提案里的背景 */
  background?: string
  approvalPolicy?: string
  sandbox?: string
  /** 子会话停下后要不要唤醒父会话 */
  wakeParent?: boolean
  /** 子会话要不要自己的工作树。不给照提案（提案也没定就照缺省） */
  worktree?: boolean
}

export interface SessionProposalAnswerParams extends SessionProposalIdParams {
  /** session：新会话（模型接着补简报开起来）；here：在这里做 */
  choice: 'session' | 'here'
  /** 选新会话时卡上那个工作树开关：记到提案上，模型补简报开起来时照它。不给照提案原来的 */
  worktree?: boolean
}

export interface SessionProposalHereParams extends SessionProposalIdParams {
  /** 发给父会话的那条消息的开头（界面语言的“在这里做：”）；不给用英文的 "Do it here: " */
  lead?: string
}

export interface SessionProposalMarkHereResult {
  /** 要以用户的话发进这个会话的那条消息 */
  text: string
}

export interface SessionProposalAcceptParams extends SessionProposalIdParams {
  overrides?: SessionProposalOverrides
}

export interface LineageUpdatedNotification {
  threadId: string
  lineage: SessionLineage | null
}

/** 一个会话的回报队列变了（进了一条、交给了模型、改成不唤醒）。notes 是现在排着的，同 litchQueuedNotes，空了是空数组 */
export interface QueuedNotesUpdatedNotification {
  threadId: string
  notes: SessionQueuedNote[]
}

export interface QueuedNotesDeliverParams {
  threadId: string
}

export interface QueuedNotesDeliverResponse {
  /** steered：插进了在跑的回合；woken：开了一个唤醒回合；none：队列已经空了，或者插不进去（留着照旧） */
  delivered: 'steered' | 'woken' | 'none'
}

export interface ProposalChangedNotification {
  threadId: string
  proposals: SessionProposal[]
  /** 这次变了的那几条（任何状态）。旧设备进程不带 */
  changed?: SessionProposal[]
}

// —— 设备进程注入给父会话的文字 ——
// 回报（附在下一条用户消息前面）和唤醒（单独一个回合）都包在这个标签里。Litch 界面认出来画成系统提示条；
// 不认识的客户端（官方桌面端）看到的是原文，所以标签里的内容要让人也看得懂。

export const SESSION_EVENT_TAG = 'litch-session-event'

/** 注入文字的种类 */
export type SessionEventKind =
  /** 子会话的回报，附在用户消息前面 */
  | 'notes'
  /** 子会话都停下了，设备进程替父会话开的回合 */
  | 'wake'
  /**
   * 用户发起的回合结束时模型没调 litch_sessions.wrap_up，设备进程替它再开的一个回合：提醒它收尾。
   * notes 是空的；一条用户消息之后最多一次
   */
  | 'remind'

/** 一条回报：哪个子会话、这一回合的结果开头 */
export interface SessionEventNote {
  pending?: SessionPendingRequest[]
  threadId: string
  title: string
  /** 子会话这一回合的结局 */
  status: 'completed' | 'failed' | 'interrupted' | 'needsUser'
  /** 最后一条回答的前 noteChars 个字；没有回答是空字符串 */
  excerpt: string
  /**
   * 这一回合结束时子会话里还有几个后台任务在跑（backgroundTasks 扩展）：照常算这一回合结束，
   * 后台跑完、引擎自己续跑的那一回合结束时会再报一次。没有的不带
   */
  backgroundTasks?: number
  /** 回合失败、被打断时回合上的错误原文，截到 noteChars 个字以内。没有的不带 */
  error?: string
  /**
   * 子会话是用户亲手停下的：在客户端里停了它的回合（interrupted），或者归档了它（archived）。
   * 这样的回报只进队列、不唤醒父会话。模型用 litch_sessions 打断的不算，不带
   */
  userStopped?: 'interrupted' | 'archived'
}

/** 排在父会话队列里、还没交给模型的一条回报：交出去之前客户端就能画出来（同 Claude 桌面端） */
export interface SessionQueuedNote extends SessionEventNote {
  /** 进队列的时间（秒） */
  at: number
}

export interface SessionEvent {
  kind: SessionEventKind
  notes: SessionEventNote[]
  /** 唤醒时还有几个子会话在干活（用户点了“立即处理”，不等它们）。都停了的不带 */
  working?: number
}

/**
 * 把一组回报包成注入的文字。第一行是给人看的标签，下面每条一段，最后一行是 JSON（界面按它画，人可以不看）。
 * 给模型的说明写在里面：这不是用户说的话，需要细节就用 litch_sessions.read。
 */
export function formatSessionEvent(event: SessionEvent): string {
  const head =
    event.kind === 'wake'
      ? event.working
        ? `Some sub-sessions you started have finished a turn; ${event.working} still working. The user asked to handle these results now. This message is from Litch, not typed by the user.`
        : 'Sub-sessions you started have finished their turns. This message is from Litch, not typed by the user.'
      : event.kind === 'remind'
        ? 'You ended your last turn without calling litch_sessions.wrap_up. This message is from Litch, not typed by the user.'
        : 'Updates from sub-sessions you started (from Litch, not typed by the user).'
  // 回答里的换行会把一条拆成几行、跟下一条混在一起，人读的这几行压成一行；原文在后面的 JSON 里
  const lines = event.notes.map((note) => {
    const excerpt = note.excerpt.replace(/\s+/g, ' ').trim()
    const background = note.backgroundTasks
      ? ` (${note.backgroundTasks} background task${note.backgroundTasks === 1 ? '' : 's'} still running; another update comes when they finish)`
      : ''
    const stopped =
      note.userStopped === 'archived'
        ? ' (archived by the user)'
        : note.userStopped === 'interrupted'
          ? ' (stopped by the user)'
          : ''
    const error = note.error ? ` (error: ${note.error.replace(/\s+/g, ' ').trim()})` : ''
    return `- "${note.title}" (${note.threadId}) ${note.status}${stopped}${background}${excerpt ? `: ${excerpt}` : ''}${error}`
  })
  const tail =
    event.kind === 'wake'
      ? `If the user’s request has steps these results unblock, continue${event.working ? ' with those only; the rest arrive when the other sub-sessions finish' : ''}; otherwise tell the user the outcome in one or two lines. Use litch_sessions.read for details and current pending request IDs. Delegate answers only through litch_sessions.respond; send messages never answer requests. Secret inputs require the user.`
      : event.kind === 'remind'
        ? 'Call litch_sessions.wrap_up now, with the suggested tasks your last reply implies or an empty list, then end your turn with at most one short line. Do not repeat or summarize your last reply: the user already has it.'
        : 'Use litch_sessions.read for details.'
  return [
    `<${SESSION_EVENT_TAG} kind="${event.kind}">`,
    head,
    ...lines,
    tail,
    // 回答里可能有 -->，把 > 写成 \u003e，JSON 照样能解析，注释也不会被提前截断
    `<!-- ${JSON.stringify(event).replace(/>/g, '\\u003e')} -->`,
    `</${SESSION_EVENT_TAG}>`,
  ].join('\n')
}

/**
 * 从一段用户消息的文字里认出注入的部分。rest 是去掉注入部分之后用户自己说的话（唤醒回合是空字符串）。
 * 没有注入部分时 event 是 null、rest 是原文。认不出 JSON 的按没有处理。
 */
export function parseSessionEvent(text: string): { event: SessionEvent | null; rest: string } {
  const pattern = new RegExp(
    `^<${SESSION_EVENT_TAG} kind="(notes|wake|remind)">\\n[\\s\\S]*?<!-- (\\{[\\s\\S]*?\\}) -->\\n</${SESSION_EVENT_TAG}>\\n?`,
  )
  const match = pattern.exec(text)
  if (!match) return { event: null, rest: text }
  try {
    const event = JSON.parse(match[2] ?? '') as SessionEvent
    if (event.kind !== match[1] || !Array.isArray(event.notes)) return { event: null, rest: text }
    return { event, rest: text.slice(match[0].length) }
  } catch {
    return { event: null, rest: text }
  }
}
