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
}

/** 会话对象上我们加的字段 */
export interface SessionTreeThreadFields {
  litchLineage?: SessionLineage
}

/** 提案的状态 */
export type SessionProposalStatus = 'pending' | 'started' | 'dismissed' | 'expired'

/** 模型提的“要不要另起一个子会话”，用户点了才起 */
export interface SessionProposal {
  id: string
  /** 提案挂在哪个会话上（就是将来的父会话） */
  threadId: string
  title: string
  /** 起子会话时发给它的第一段话 */
  prompt: string
  /** 子会话的 harness。不给是父会话的 */
  harness: string | null
  model: string | null
  cwd: string | null
  kind: SessionLineageKind
  wakeParent: boolean
  status: SessionProposalStatus
  createdAt: number
  /** 到这个时间（秒）还没点就过期 */
  expiresAt: number
  /** status 是 started 时，起出来的子会话 */
  startedThreadId: string | null
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
} as const

// —— 客户端发起的方法（只在设备信息的 extensions 里列了 sessionTree 时可用） ——

export const SESSION_TREE_METHOD = {
  /** 用户在界面上派一个子会话。应答 SessionStartResponse */
  start: 'litch/session/start',
  /** 把一个子会话脱离成独立会话（去掉父子关系，会话本身不动）。应答空对象 */
  detach: 'litch/session/detach',
  /** 一个会话上的提案（只列 pending 的）。应答 SessionProposalListResponse */
  proposalList: 'litch/sessionProposal/list',
  /** 用户点“开始”。应答 SessionStartResponse */
  proposalAccept: 'litch/sessionProposal/accept',
  /** 用户点“不要”。应答空对象 */
  proposalDismiss: 'litch/sessionProposal/dismiss',
} as const

export const SESSION_TREE_NOTIFICATION = {
  /** 一个会话的父子关系变了（建立、脱离）。lineage 为 null 是没有父会话了 */
  lineageUpdated: 'litch/thread/lineage/updated',
  /** 一个会话上的提案变了（新提、开始、不要、过期）。带的是这个会话现在全部 pending 的提案 */
  proposalChanged: 'litch/sessionProposal/changed',
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
  /** 发给子会话的第一段话 */
  prompt: string
  wakeParent: boolean
  /** 审批策略、沙箱：给了也会被收紧到不宽于父会话 */
  approvalPolicy?: string
  sandbox?: string
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
}

export interface SessionProposalListResponse {
  proposals: SessionProposal[]
}

export interface SessionProposalIdParams {
  proposalId: string
}

export interface LineageUpdatedNotification {
  threadId: string
  lineage: SessionLineage | null
}

export interface ProposalChangedNotification {
  threadId: string
  proposals: SessionProposal[]
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

/** 一条回报：哪个子会话、这一回合的结果开头 */
export interface SessionEventNote {
  threadId: string
  title: string
  /** 子会话这一回合的结局 */
  status: 'completed' | 'failed' | 'interrupted' | 'needsUser'
  /** 最后一条回答的前 noteChars 个字；没有回答是空字符串 */
  excerpt: string
}

export interface SessionEvent {
  kind: SessionEventKind
  notes: SessionEventNote[]
}

/**
 * 把一组回报包成注入的文字。第一行是给人看的标签，下面每条一段，最后一行是 JSON（界面按它画，人可以不看）。
 * 给模型的说明写在里面：这不是用户说的话，需要细节就用 litch_sessions.read。
 */
export function formatSessionEvent(event: SessionEvent): string {
  const head =
    event.kind === 'wake'
      ? 'Sub-sessions you started have finished their turns. This message is from Litch, not typed by the user.'
      : 'Updates from sub-sessions you started (from Litch, not typed by the user).'
  const lines = event.notes.map(
    (note) =>
      `- "${note.title}" (${note.threadId}) ${note.status}${note.excerpt ? `: ${note.excerpt}` : ''}`,
  )
  const tail =
    event.kind === 'wake'
      ? 'If the user’s request has steps these results unblock, continue; otherwise tell the user the outcome in one or two lines. Use litch_sessions.read for details. Do not answer requests that are waiting for the user inside a sub-session.'
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
    `^<${SESSION_EVENT_TAG} kind="(notes|wake)">\\n[\\s\\S]*?<!-- (\\{[\\s\\S]*?\\}) -->\\n</${SESSION_EVENT_TAG}>\\n?`,
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
