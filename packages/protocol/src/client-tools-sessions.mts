// litch_sessions：模型列出、读取同一台设备上的会话，查能用的 harness 和型号，派出子会话，给自己的子会话发消息、打断，等它们结束，
// 用户同意后归档、恢复会话。
// 和 litch_browser 这些不同，执行方是设备进程自己，不是桌面端（会话在设备上）：建会话时带不带它看的是
// 设备信息的 extensions 有没有 sessionTree、设置里“会话编排”开没开，不看桌面端的声明；设备进程替每条
// 通往引擎的连接声明能执行它，调用到了设备进程就自己答，不转给任何客户端。父子关系、提案见 session-tree.mts，
// 规矩写在 protocol/extensions/session-tree.json。说明是写给模型看的，用英文。
//
// 只引用协议包内自包含的类型与工具声明。
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientToolFunctionSpec,
  type ClientToolNamespaceSpec,
} from './client-tools.mjs'
import type { SessionDelegatedResponse, SessionPendingRequest } from './session-pending.mjs'
import type { SessionLineageKind } from './session-tree.mjs'

export const SESSION_TOOL = {
  list: 'list',
  read: 'read',
  setWake: 'set_wake',
  respond: 'respond',
  /** 这台设备上能开子会话的 harness、各自的型号和强度、这个会话现在用的：换 harness 或型号之前先查 */
  options: 'options',
  start: 'start',
  send: 'send',
  wait: 'wait',
  interrupt: 'interrupt',
  /** 用户在最新一条消息里让开始某张提案卡片（“开始第二个”） */
  accept: 'accept',
  /** 撤回自己提的、用户还没开始的提案 */
  withdraw: 'withdraw',
  /** 每回合最后必须调一次的收尾：带上这回合的建议任务（没有就空列表） */
  wrapUp: 'wrap_up',
  /** 做到一半来了一条无关的新消息：把手上的任务连同剩下的计划交给一个分叉会话，立刻开始 */
  handOff: 'hand_off',
  /** 归档一个会话（自己派出的、用户点名的别的会话，或者 self 这个会话自己）：只在用户同意之后 */
  archive: 'archive',
  /** 把归档了的会话放回列表 */
  unarchive: 'unarchive',
} as const

export type SessionToolName = (typeof SESSION_TOOL)[keyof typeof SESSION_TOOL]

export const SESSION_TOOL_LIMITS = {
  /** list 最多回多少个 */
  listMax: 50,
  /** options 里每个 harness 最多列几个型号（多出来的标 truncated，可以用 harness 只查那一个） */
  optionsModelsMax: 100,
  /** read 缺省读最近几个回合、最多几个 */
  readTurnsDefault: 3,
  readTurnsMax: 10,
  /** read 里每段文字（用户的话、最后的回答）最多多少字，掐头留尾 */
  readTextChars: 4000,
  /** wait 最多等几个会话 */
  waitThreadsMax: 8,
  /** wait 最多等多少秒 */
  waitSecondsMax: 120,
  /** send 的消息、start 的 prompt、background 各自最多多少字 */
  messageChars: 32_000,
  /** 一个回合里最多提几张提案（硬上限；规则里写主动提的三张，拆计划时四张） */
  proposalsPerTurn: 4,
  /** 规则里主动提的建议一回合最多几张（设备进程不单独查，照 proposalsPerTurn 拦） */
  proactivePerTurn: 3,
  /**
   * fresh 的提案、直接起的 fresh 子会话，background 至少多宽（textWidth：汉字等宽字符算 2）：子会话看不到父会话，
   * 只知道背景和任务这两段，背景写短了它不知道这件事从哪来、做到哪了。prompt 只要非空
   */
  freshBackgroundMinWidth: 80,
  /** wrap_up 的回复按钮最多几个；按钮上的字、点了发出的话、问题各自最多多少字 */
  wrapUpActions: 2,
  actionLabelChars: 24,
  actionMessageChars: 300,
  askChars: 100,
} as const

// —— 参数（执行器收到后自己校验，不信任这里） ——

export interface SessionsListArguments {
  /** mine：自己派出的子孙会话；all：这台设备上所有会话（缺省） */
  scope?: 'mine' | 'all'
  /** 只列这个 harness 的 */
  harness?: string
  /** 只列这个目录下的 */
  cwd?: string
  /** 只列在跑的 / 停着的 */
  status?: 'running' | 'idle'
  limit?: number
}

export interface SessionsOptionsArguments {
  /** 只查这个 harness */
  harness?: string
}

export interface SessionsReadArguments {
  thread_id: string
  /** 最近几个回合 */
  turns?: number
}

export interface SessionsSetWakeArguments {
  thread_id: string
  wake: boolean
}

export interface SessionsSetWakeResult {
  thread_id: string
  wake_parent: boolean
}

export interface SessionsStartArguments {
  title: string
  /** 默认 true；只控制自动唤醒，回报仍交付。 */
  wake_parent?: boolean
  /**
   * 子会话收到的第一段话：任务、相关文件、做完的标准。子会话看不到这个会话的内容（fork 除外）。
   * initiation 是 offer 时不给（只带标题先出卡，用户选了新会话再用 accept 补）
   */
  prompt?: string
  /**
   * fresh 时必填：给没看过这段对话的人看的背景（整体目标、到目前为止的决定和约束、这一块怎么接上）。
   * fork 不看（子会话本来就带着整段对话）；offer 不给（accept 时补）
   */
  background?: string
  /** 不给是这个会话的 harness */
  harness?: string
  model?: string
  /** 不给是开始那一刻这个会话的（harness 不同时是那边的默认） */
  effort?: string
  /** 不给是这个会话的目录 */
  cwd?: string
  /** 缺省 fresh。fork 带上这个会话的全部上下文，只能同 harness */
  kind?: SessionLineageKind
  /**
   * true：子会话有自己的 git 工作树和分支（从这个会话分支的最新提交切）；false：在这个会话的目录里做。
   * 不给：这个会话在 Litch 建的工作树里（或者共用着一棵）就开新的，否则共用目录。offer 不给（用户在卡上定）
   */
  worktree?: boolean
  /**
   * user_asked：用户在这个回合里亲口要求起这个会话，直接起（设备进程还要核对这个回合确实是用户发起的，
   * 不是就降成提案）；propose（缺省）：出一张提案卡片，用户点了才起；
   * offer：用户这条消息是和这个会话无关的新任务，只带标题出一张“新会话 / 在这里做”的卡，调用一直等到用户选
   *（选了新会话，结果让模型用 accept 带上简报开起来；选了在这里做、用户又发了话、回合被打断，都是在这里做）
   */
  initiation?: 'user_asked' | 'propose' | 'offer'
}

export interface SessionsAcceptArguments {
  proposal_id: string
  effort?: string
  /** 开始 offer 卡时补的简报（用户选了新会话之后）；别的卡不给，照提案里的 */
  prompt?: string
  /** 同上，fresh 时必填 */
  background?: string
  title?: string
  harness?: string
  model?: string
  cwd?: string
  kind?: SessionLineageKind
}

export interface SessionsHandOffArguments {
  /** 交出去的任务叫什么，60 字以内 */
  title: string
  /** 还剩什么：步骤、文件、怎样算完。分叉会话带着这个会话到上一个回合为止的全部上下文，再收到这一段 */
  remaining_plan: string
  /** 同 SessionsStartArguments.worktree */
  worktree?: boolean
}

export interface SessionsWithdrawArguments {
  proposal_id: string
}

/** wrap_up 里的一条建议：和 start 的提案一样，只是不能直接起 */
export interface SessionsSuggestion {
  title: string
  prompt: string
  /** 不给是开始那一刻这个会话的（harness 不同时是那边的默认），model 同 */
  effort?: string
  /** fresh 时必填，见 SessionsStartArguments.background */
  background?: string
  harness?: string
  model?: string
  cwd?: string
  kind?: SessionLineageKind
  /** 同 SessionsStartArguments.worktree */
  worktree?: boolean
}

/** wrap_up 的一个回复按钮：点了把 message（没有就是 label）当用户消息发回这个会话 */
export interface SessionsWrapUpAction {
  label: string
  message?: string
}

export interface SessionsWrapUpArguments {
  /** 没有建议时是空数组；最多 proposalsPerTurn 条（和这回合里 start 提的合起来算） */
  suggestions: SessionsSuggestion[]
  /**
   * 这一回合留给用户定的一件事（一个短问题），比如要不要在这里接着做刚查出来的事；没有就不给。
   * 和按钮一起留在待答区，直到用户明确回答或模型撤回
   */
  ask?: string
  /** ask 的回复按钮，1 到 wrapUpActions 个，第一个是推荐的；没有 ask 时不给 */
  actions?: SessionsWrapUpAction[]
  /** 明确撤回的待答问题原文。只作用于这次调用之前的问题。 */
  withdraw_questions?: string[]
}

export interface SessionsSendArguments {
  thread_id: string
  message: string
}

export interface SessionsWaitArguments {
  thread_ids: string[]
  timeout_seconds?: number
}

export interface SessionsInterruptArguments {
  thread_id: string
}

/** archive 的 thread_id 写成它是这个会话自己：这个回合结束时归档 */
export const SESSION_SELF = 'self'

export interface SessionsArchiveArguments {
  /** 会话号，或者 SESSION_SELF */
  thread_id: string
}

export interface SessionsUnarchiveArguments {
  thread_id: string
}

// —— 结果（成功时整段 JSON 作为一条文字回给模型） ——

export type SessionStatusWord = 'running' | 'idle' | 'needsUser' | 'failed' | 'unavailable'

export interface SessionSummary {
  thread_id: string
  title: string
  harness: string
  cwd: string
  status: SessionStatusWord
  /** 秒 */
  updated_at: number
  /** Litch 父子关系里的父会话；没有是 null */
  parent_thread_id: string | null
  /** 子会话当前的自动唤醒开关；没有 Litch 父会话时为 null。 */
  wake_parent: boolean | null
  /** 是不是调用者自己派出的子孙 */
  mine: boolean
}

export interface SessionsListResult {
  sessions: SessionSummary[]
  /** 没列全时为 true */
  truncated: boolean
}

/** options 里的一个型号 */
export interface SessionModelOption {
  /** start、accept、wrap_up 建议的 model 照它填（Claude Code 是 `<供应商>/<型号>`） */
  id: string
  /** 给人看的名字（Claude Code 有多个供应商时是“[供应商] 模型名”） */
  name: string
  /** 支持的强度，填 effort 用；空是没列 */
  efforts: string[]
  /** 不给 effort 时用的那一档；没有就不给 */
  default_effort?: string
}

/** options 里的一个 harness */
export interface SessionHarnessOptions {
  harness: string
  /** 现在开不了（没装、没在运行、连不上）的原因；能开的不给，models 是空的 */
  unavailable?: string
  /** 不给 model 时新会话用的型号；列不出来是 null */
  default_model: string | null
  /** 能选的型号，和型号选单一致（没登录、没填密钥的供应商不列） */
  models: SessionModelOption[]
  /** 型号多于 optionsModelsMax、没列全时为 true */
  truncated?: boolean
}

export interface SessionsOptionsResult {
  /** 这个会话现在用的；读不出来的是 null */
  current: { harness: string; model: string | null; effort: string | null }
  harnesses: SessionHarnessOptions[]
}

export interface SessionTurnSummary {
  /** 用户（或注入）的话，掐过 */
  input: string
  /** 最后一条回答，掐过；还在跑是 null */
  answer: string | null
  status: 'completed' | 'failed' | 'interrupted' | 'inProgress'
}

export interface SessionsReadResult {
  session: SessionSummary
  turns: SessionTurnSummary[]
  /** 当前设备连接观察到的阻塞请求，不包含异步或收尾问题。 */
  pending_requests: SessionPendingRequest[]
  delegated_responses: SessionDelegatedResponse[]
}

export interface SessionsRespondArguments {
  thread_id: string
  request_id: string
  answer: { decision: unknown } | { answers: Record<string, string[]> }
}

export interface SessionsRespondResult {
  answered: true
  response: SessionDelegatedResponse
}

export interface SessionsStartResult {
  /** 直接起了：子会话号 */
  thread_id?: string
  /** 降成了提案、出了 offer 卡：提案号 */
  proposal_id?: string
  /** offer 卡上用户选了什么：session 是新会话（接着用 accept 带上简报），here 是在这里做 */
  choice?: 'session' | 'here'
  /** 给模型的一句话：起了、还是等用户点、用户选了什么接下来怎么做 */
  note: string
}

export interface SessionsHandOffResult {
  /** 起出来的分叉会话 */
  thread_id: string
  note: string
}

/** wrap_up 的结果：每条建议成了哪张提案，或者为什么没收 */
export interface SessionsWrapUpResult {
  suggestions: { title: string; proposal_id?: string; refused?: string }[]
  note: string
}

/** withdraw 的结果：撤回了，或者已经不能撤回（用户已开始、已不要、已过期） */
export interface SessionsWithdrawResult {
  status: 'withdrawn' | 'started' | 'dismissed' | 'expired'
  /** status 是 started 时起出来的子会话 */
  thread_id?: string
  note: string
}

/** archive 的结果。self 的要等回合结束才归档，只有 note */
export interface SessionsArchiveResult {
  thread_id: string
  /** 跟着它一起归档的子孙会话（已经停下的） */
  archived_with?: string[]
  /** 还在干活、留在列表里的子孙会话 */
  left_live?: string[]
  note: string
}

export interface SessionsUnarchiveResult {
  thread_id: string
  note: string
}

export interface SessionsWaitResult {
  /** 到点还没停的也在里面，status 是 running */
  sessions: (SessionSummary & { last_answer: string | null })[]
  timed_out: boolean
}

/**
 * 显示宽度：汉字、假名、谚文、全角符号这类等宽字符算 2，其余算 1。简报门槛按它算，中文和英文写到差不多的信息量就够。
 */
export function textWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)
    width += wide ? 2 : 1
  }
  return width
}

/** 掐成最多 limit 个字（按码点算，不切开代理对），前后空白去掉 */
const clip = (value: string, limit: number): string =>
  Array.from(value.trim()).slice(0, limit).join('').trim()

/**
 * 把 wrap_up 参数里的 ask、actions 按规矩整理成能画的样子（session-tree.json 的规矩）：超长的截断，按钮多于
 * wrapUpActions 的丢掉多的，label 是空的、不是对象的按钮丢掉，message 是空的去掉，没有 ask 时连按钮一起不要。
 * 都不算错。设备进程收尾时用它，界面从调用参数里读出来画之前也用它（两边按同一份规矩）。没有 ask 是 null；
 * trimmed 是有没有改动过（给模型的那句话里提一句）
 */
export function wrapUpAsk(args: unknown): {
  value: { ask: string; actions: SessionsWrapUpAction[] } | null
  trimmed: boolean
} {
  const fields = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}
  const given = fields.ask
  const actionsGiven = fields.actions
  const ask = typeof given === 'string' ? clip(given, SESSION_TOOL_LIMITS.askChars) : ''
  if (!ask) return { value: null, trimmed: given != null || actionsGiven != null }
  let trimmed = ask !== given
  const actions: SessionsWrapUpAction[] = []
  const list = Array.isArray(actionsGiven) ? actionsGiven : []
  if (actionsGiven != null && !Array.isArray(actionsGiven)) trimmed = true
  for (const one of list) {
    const action = typeof one === 'object' && one !== null ? (one as Record<string, unknown>) : {}
    const label =
      typeof action.label === 'string'
        ? clip(action.label, SESSION_TOOL_LIMITS.actionLabelChars)
        : ''
    if (!label || actions.length >= SESSION_TOOL_LIMITS.wrapUpActions) {
      trimmed = true
      continue
    }
    const message =
      typeof action.message === 'string'
        ? clip(action.message, SESSION_TOOL_LIMITS.actionMessageChars)
        : ''
    if (label !== action.label || message !== (action.message ?? '')) trimmed = true
    actions.push(message ? { label, message } : { label })
  }
  return { value: { ask, actions }, trimmed }
}

/**
 * 建议任务（提案卡片）的规矩：挂上 litch_sessions 时加进系统提示（命名空间的 instructions）。
 * 结构和判断条件照 Claude 桌面端现行的同类提示，用自己的话写，不另加 Litch 自己的特例：先说什么才配单开一个会话
 *（自成一件事；当前任务的一部分不算），再按请求对这个会话是什么（第一件任务、接着做、新任务、用户明说）分流；
 * 接着这次发现往下做的那一件留在这里，用收尾的 ask 加按钮问；没做完、没验到的还是这个任务；大多数回合没有后续；
 * 拿不准时看简报是不是大半在复述这里查到的。
 * 只靠规则模型不会主动提（16 号设计第 0 条的验收），所以每回合收尾必须调 wrap_up，建议放在它的参数里；
 * 用户发起的回合没调，设备进程会再开一个回合提醒（SessionEventKind 的 remind）。
 * 顺序照 Claude 桌面端：先收尾、再写最终回答。反过来的话回合最后一段是“回答已经给你了”这种短话，
 * 只认最后一段为回答的界面会把真正的回答收进过程。
 * wrapUp 是设置里“每回合收尾”的开关（设备进程按它换掉客户端给的这组工具）：关掉时没有 wrap_up 这个工具，
 * 规则里也不提收尾，建议改用 start 的 propose，要用户定的事写在回答最后一行。
 * taskCards 是这个 harness 的“任务卡”开关（设备设置 harness.<id>.taskCards）：关着时规则里不提建议、offer、收尾，
 * 只留用户明说时派子会话、交接、简报这几条（wrapUp 不起作用）
 */
export function sessionProposalRules(wrapUp: boolean, taskCards = true): string {
  if (!taskCards) return plainSessionRules()
  return [
    'Separate sessions and suggested tasks (Litch). A task of its own can run in a separate session on this device, possibly on another harness, model or folder: the user starts it with one click on a card in this conversation, and nothing runs until then.',
    SESSION_PURPOSE,
    'Before acting on a request, decide what it is to this session:',
    '- The first task: until a task has been finished in this session, the request is simply what this session is for. Do it here.',
    "- A continuation: anything that builds on what was done, found or decided here (a correction, a follow-up, a question, the next iteration, going ahead with what you just investigated or suggested, even when it will get its own commit), and anything a few tool calls settle, whatever it is about. Do it here. When unsure, it is a continuation: a wrong offer stops the user's work, a wrong continuation only makes this session a little longer.",
    '- A new task: after a task has been finished here, unrelated work that a fresh session would do just as well from the user\'s words alone, because it builds on nothing done, found or decided here. Your first action is litch_sessions.start with initiation "offer" and a title only, with no other tool call and no plan before it: the user gets a "New session / Do it here" card and the call waits for their choice. If they choose a new session, call litch_sessions.accept with the proposal_id and the full brief; if they choose here, do it here.',
    USER_ASKED,
    `A task of its own that you notice or conclude while you work and the user has not asked for (out-of-scope work, a fix spotted in passing, the follow-up your answer recommends, also in a turn that only answered a question) becomes a card: one card per independent piece, at most ${SESSION_TOOL_LIMITS.proactivePerTurn} per turn, never the same piece twice, never what you are about to do anyway. A task the user's message tells you to do is never one of these: it is the first task, a continuation, a new task or user_asked.`,
    `One piece of work that acts on what this session just found, such as the fix for what you diagnosed, stays here while this session has nothing else in flight (no unfinished change or running sub-session for other work): a new session would have to find it all again. It is not a card and gets no brief: ${wrapUp ? "ask about it with wrap_up's ask and a reply button that has you do it here" : 'ask about it in one short question as the last line of your answer'}, and do it when the user says yes.`,
    'A piece you left or could not verify is still this task, not a follow-up: finish or check it now, here or in a subagent, or say plainly in your answer what is not done or not verified.',
    'A follow-up you name gets a card or a question, not just a sentence: when your reply calls some work a follow-up, a separate change or "for later", and it is real work worth doing next (not a one-line tweak or speculation), put it to the user before the turn ends: the one piece that acts on what you just found as that question, any other task of its own as a card. The card or the question is how you ask for their OK, so do not ask again in prose ("want me to ...?"); mention the cards in one line.',
    'When unsure whether something is a task of its own: if the brief you would write mostly retells what you found here, it stays here.',
    `After the user accepts a plan, check whether two or more of its steps are real work that can each run on its own: none needs another step's result or changes already made in this session, none is needed by another step, none touches files another step touches, none must land in one change with another. A last step that only checks the finished work does not count. When at least two pass and the user has not said where to run them, say in one line which step you start on, and propose each of the others right away with litch_sessions.start (initiation "propose"), at most ${SESSION_TOOL_LIMITS.proposalsPerTurn}. Right before you begin a step you proposed, withdraw its card; if the user already started it, leave that step to its session.`,
    "Not for a card: anything that first needs the user's decision. Ask about it, and suggest only the parts that do not depend on it.",
    HAND_OFF,
    wrapUp
      ? 'Every turn ends with litch_sessions.wrap_up and then your final answer, in that order. When the work is done (in a turn that only answers a question: before you write the answer), call wrap_up exactly once. Part of wrapping up is deciding, unasked, whether the request left a real follow-up and where it runs. Most turns leave no card: a task of its own (work that lands apart from this change, something the user set aside earlier, or a self-contained next task better started fresh than from a long history; never work unrelated to the request) goes into suggestions, skipping cards you already proposed this turn. A decision or step the turn leaves to the user goes into ask: that one decision as one short question, with reply buttons in actions, your pick first. The usual one is going ahead here with what you just found, also after a turn that only investigated or answered a question and turned up something to act on (a cause, a bug, a list of fixes). With neither, pass an empty suggestions list and no ask. Then write your final answer to the user as the last message of the turn: complete on its own, never a summary of or a pointer to text above it, because what came before wrap_up is shown folded as work in progress. If you skip wrap_up, Litch reminds you in a new message.'
      : 'Most turns leave no follow-up. To suggest a task of its own, call litch_sessions.start with initiation "propose": each call makes one card the user can start; nothing runs until they do. Write your final answer to the user as the last message of the turn.',
    FRESH_BRIEF,
    WORKTREE_RULE,
    TITLE_LINE,
    'If the user tells you to start a card ("start the second one"), call litch_sessions.accept with its proposal_id. If a card went stale (done here after all, no longer needed, replaced by a better one), withdraw it with litch_sessions.withdraw; propose the replacement first.',
    archiveRule(wrapUp),
    outsideLitch(wrapUp),
  ].join('\n')
}

/**
 * 不在 Litch 里了的兜底：Litch 建的会话被拿到别的客户端（比如官方桌面端分叉、接着用）时，规则还在上下文里，
 * litch_* 工具却调不通（报不支持这个命名空间、没有这个工具）。不写这一句，模型每个回合都去调收尾、一直报错。
 * 没有收尾的那几份不提 wrap_up
 */
export function outsideLitch(wrapUp: boolean): string {
  return `If a litch_* tool call fails because its namespace or the tool is not supported or does not exist (for example "Unsupported dynamic tool namespace"), this conversation is no longer running in Litch. From then on do not call any litch_* tool in this conversation${wrapUp ? ', wrap_up included,' : ''} and skip the steps above that need them; just answer the user.`
}

/** 什么才配单开一个会话：几份规则共用 */
const SESSION_PURPOSE =
  'What a separate session is for: a task of its own. It outlives this turn, a short brief is enough to start it, the user may want to open, steer or review it apart from this work, and it ends in something of its own (a branch, a pull request, a change in another repository). A piece of the task at hand is never one, however large or parallel: searching or reading widely, independent parts of one change, and testing, checking or reviewing what you built run here or in your own subagents, whose results come back to you in this turn. Quick things (a question, a read, one edit, a handful of tool calls) stay here.'

const USER_ASKED =
  '- The user asked in words for separate, parallel or background work, or told you to start a piece now: litch_sessions.start with initiation "user_asked", one session per independent piece. Pieces whose results you need for your answer in this turn go to your own subagents instead, unless the user asked for sessions.'

const HAND_OFF =
  'If a new user message about something unrelated arrives while you are in the middle of a task, hand that task off with litch_sessions.hand_off (a title and the remaining plan: steps, files, what done looks like), then answer the new message. A small correction is not that: just adjust. If the user said to keep working here, keep it here.'

const FRESH_BRIEF = `A fresh session sees nothing of this conversation: it gets only the two parts of its brief, written in your own words for someone who has not read any of this. background: the overall goal, what has been decided or ruled out so far, the constraints to respect, and how this piece fits in (at least ${SESSION_TOOL_LIMITS.freshBackgroundMinWidth} wide; a CJK character counts as 2). prompt: the task itself, the files or area, and what done looks like. A fork already has this conversation, so it needs only the prompt. Follow-ups for a session you started go to it with litch_sessions.send, not to a new session.`

const WORKTREE_RULE =
  "Where a new session works: work that ends in a branch or pull request of its own gets its own git worktree (worktree true; the folder must be in a git repository), so it does not mix with this session's changes; work that must land in one change with this one, or only reads, shares this folder (worktree false). Leave worktree out to follow the default: a new worktree when this session is in a worktree Litch created, otherwise this folder. A new worktree starts from the last commit of this session's branch, so commit first what it needs. If this session is already in a worktree Litch created, do not create another one with your own worktree tool (for example EnterWorktree)."

/**
 * 归档：照 Claude 桌面端 archive_session 的用法，只在用户同意了归档那个会话之后才归档，不自己拿主意；
 * 子会话都跑完、结果到手之后可以提议归档它们，用户说好再归档。有收尾时用收尾的 ask 问
 */
function archiveRule(wrapUp: boolean): string {
  return `Archiving: litch_sessions.archive moves a session to Archived, and litch_sessions.unarchive brings it back. Archive a session only after the user has explicitly agreed to archiving that specific session, never on your own or speculatively. When all of your sub-sessions have finished and you have their results, you may ask the user whether to archive them (${wrapUp ? "with wrap_up's ask and a reply button" : 'in one short question'}) and archive them when they say yes.`
}

const TITLE_LINE =
  'Right before each litch_sessions.start or hand_off, write a bold title line and one sentence on what it will do.'

/** 任务卡关着时的规则：只有用户明说时派子会话、交接、简报，不提建议、offer、收尾 */
function plainSessionRules(): string {
  return [
    'Separate sessions (Litch). Work can run in a separate session on this device, possibly on another harness, model or folder, when the user asks for it.',
    SESSION_PURPOSE,
    USER_ASKED.slice(2),
    HAND_OFF,
    FRESH_BRIEF,
    WORKTREE_RULE,
    TITLE_LINE,
    'If the user tells you to start one of the cards already in this conversation, call litch_sessions.accept with its proposal_id. Write your final answer to the user as the last message of the turn.',
    archiveRule(false),
    outsideLitch(false),
  ].join('\n')
}

/** 收尾开着（默认）、任务卡开着时的规则：客户端带的就是这一份 */
export const SESSION_PROPOSAL_RULES = sessionProposalRules(true)

const WORKTREE_PARAM = {
  type: 'boolean',
  description:
    'true: its own git worktree and branch, from the last commit of this session’s branch. false: this session’s folder. Default: a new worktree when this session is in a worktree Litch created, otherwise this folder. Not for "offer" (the user picks on the card).',
}
const THREAD_ID = { type: 'string', description: 'Session id (thread id) from list or start.' }
const PROPOSAL_ID = { type: 'string', description: 'proposal_id returned by start.' }

/** 收尾：每回合干完活先调它、再写最终回答（设置里“每回合收尾”关掉时不给） */
const WRAP_UP_TOOL: ClientToolFunctionSpec = {
  type: 'function',
  name: SESSION_TOOL.wrapUp,
  description: `Call this exactly once in every turn, when the work is done and before your final answer, even when there is nothing to pass (an empty suggestions list, no ask); then write the final answer as the last message of the turn, complete on its own (not a summary of or a pointer to text above). First decide, unasked, whether the request left a real follow-up and where it runs; most turns leave none. suggestions: tasks of their own, each a card the user can start (nothing runs until they do): work that lands apart from this change, something the user set aside earlier, or a self-contained next task better started fresh; never unrelated work, and never a piece of this task (a piece you left or could not verify is this task: finish it, or say so in your answer). ask and actions: the one decision or step this turn leaves to the user, such as going ahead here with the one piece of work that acts on what you just found (that piece is never a card), also after a turn that only investigated or answered a question. At most ${SESSION_TOOL_LIMITS.proposalsPerTurn} cards per turn, counting start proposals.`,
  inputSchema: {
    type: 'object',
    properties: {
      suggestions: {
        type: 'array',
        description: `Suggested tasks of this turn; empty when there are none. At most ${SESSION_TOOL_LIMITS.proposalsPerTurn}.`,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title, under 60 characters.' },
            prompt: {
              type: 'string',
              description: 'The task: what to do, the files or area, what done looks like.',
            },
            background: {
              type: 'string',
              description: `Required for fresh (ignored for fork): context for someone who has not seen this conversation: the overall goal, decisions and constraints so far, how this piece fits in (at least ${SESSION_TOOL_LIMITS.freshBackgroundMinWidth} wide; a CJK character counts as 2).`,
            },
            harness: { type: 'string', description: 'Default: this session’s harness.' },
            model: {
              type: 'string',
              description:
                'Default: this session’s current model (the target harness’s default when the harness differs). To change it, pass a model id listed by options.',
            },
            effort: {
              type: 'string',
              description:
                'Reasoning effort. Default: this session’s current effort (the target harness’s default when the harness differs).',
            },
            cwd: { type: 'string', description: 'Default: this session’s folder.' },
            worktree: WORKTREE_PARAM,
            kind: {
              type: 'string',
              enum: ['fresh', 'fork'],
              description:
                'fork copies this whole conversation (same harness only). Default fresh.',
            },
          },
          required: ['title', 'prompt'],
          additionalProperties: false,
        },
      },
      ask: {
        type: 'string',
        description: `Only when this turn leaves the user a decision to make or a step to take (for example whether to go ahead here with the fix for what you just found): that one decision as one short question, under ${SESSION_TOOL_LIMITS.askChars} characters, never two joined by "and", with no reason or recommendation and without listing the options the buttons give. Omit when nothing waits on the user.`,
      },
      actions: {
        type: 'array',
        description: `Reply buttons answering ask, 1 to ${SESSION_TOOL_LIMITS.wrapUpActions}. The first is your recommendation; add a second only when it is a realistic alternative the user might pick. A click sends message (or the label) back to you as the user's words. Only with ask.`,
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: `Button text in the user's voice, 1-3 words (for example "Yes, fix it"), under ${SESSION_TOOL_LIMITS.actionLabelChars} characters.`,
            },
            message: {
              type: 'string',
              description: `What the click sends as the user's words, plain text under ${SESSION_TOOL_LIMITS.actionMessageChars} characters. Omit when the label says it all.`,
            },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
      withdraw_questions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Exact titles of earlier pending questions to explicitly withdraw because they no longer need an answer. Automated turns and an empty wrap_up never withdraw questions. Omit unless deliberately withdrawing.',
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  },
}

/** 命名空间说明里讲建议的那一句，跟着两个开关 */
function suggestionLine(wrapUp: boolean, taskCards: boolean): string {
  if (!taskCards)
    return 'Start one only when the user asks for it in words (start, initiation "user_asked").'
  return `${wrapUp ? 'Every turn ends with wrap_up and then your final answer; most turns have nothing to pass, and a task of its own goes into its suggestions as a card.' : 'A task of its own becomes a card with start (initiation "propose").'} A new task unrelated to this session starts with an offer (start, initiation "offer").`
}

/** start 的说明：任务卡关着时只有 user_asked */
function startDescription(wrapUp: boolean, taskCards: boolean): string {
  const fresh = `A fresh sub-session knows only background and prompt: background gives the context it cannot see (at least ${SESSION_TOOL_LIMITS.freshBackgroundMinWidth} wide; a CJK character counts as 2), prompt the task. Harness, model, effort and folder default to this session's current ones (model and effort: the target harness's defaults when the harness differs). To use another harness or model, call options first and pass the ids it lists.`
  if (!taskCards)
    return `Start a sub-session the user asked for in their latest message (initiation "user_asked"); it starts now and runs on its own. ${fresh}`
  return `Start a sub-session, propose one, or offer a new session. initiation "user_asked": the user asked for separate work in their latest message; it starts now. "propose" (default): a card the user may start; nothing runs until they do (at most ${SESSION_TOOL_LIMITS.proposalsPerTurn} cards per turn). "offer": after a task has been finished in this session, the user's latest message is a new task unrelated to it; send the title only, as the only call in that message; the card asks the user "New session" or "Do it here" and the call waits for the answer, which tells you what to do next. ${fresh}${wrapUp ? ' To suggest work at the end of a turn, use wrap_up instead.' : ''}`
}

/**
 * litch_sessions 这组工具。wrapUp 跟着设置里“每回合收尾”的开关，taskCards 跟着这个 harness 的“任务卡”开关
 *（关着时没有 wrap_up，start 只收 user_asked，规则不提建议）：客户端带的是都开着的那份（SESSION_TOOLS），
 * 设备进程建会话时按设置和会话的 harness 换成对应的那份（session-tree.mts 的 currentSessionTools）
 */
export function sessionTools(wrapUp: boolean, taskCards = true): ClientToolNamespaceSpec {
  return {
    type: 'namespace',
    name: CLIENT_TOOL_NAMESPACE.sessions,
    description: `Litch sessions on this device. A sub-session is a full, separate session the user can open and talk to; it is for a task of its own that the user may want to follow apart from this work, or for work that needs another harness, model or folder. Parts of the task at hand, however large, run here or in your own subagents. ${suggestionLine(wrapUp, taskCards)} Results of your sub-sessions arrive later as a <litch-session-event> message; do not poll. Send to/interrupt sub-sessions or any session on a user-started turn; also send to any with past messages either way; archive only when the user agreed. Use respond for delegated answers; secret inputs require the user. Send never answers. If these tools report an unsupported namespace or a missing tool, you are not in Litch: stop calling litch_* tools in this conversation.`,
    instructions: sessionProposalRules(wrapUp, taskCards),
    tools: [
      {
        type: 'function',
        name: SESSION_TOOL.list,
        description:
          'List sessions on this device, newest first, including wake_parent (null for sessions without a Litch parent).',
        inputSchema: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              enum: ['mine', 'all'],
              description: 'mine: only sub-sessions you started (and theirs). Default all.',
            },
            harness: { type: 'string', description: 'Only this harness, e.g. claude-code, codex.' },
            cwd: { type: 'string', description: 'Only sessions in this folder.' },
            status: { type: 'string', enum: ['running', 'idle'] },
            limit: { type: 'integer', minimum: 1, maximum: SESSION_TOOL_LIMITS.listMax },
          },
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.read,
        description:
          'Read a session’s status, wake_parent, recent turns, pending_requests and delegated_responses without opening it. Pending requests include current IDs, kinds, questions and permitted decisions for respond. This snapshot covers blocking requests observed by the device; an empty list does not rule out asynchronous questions or requests held by another executor.',
        inputSchema: {
          type: 'object',
          properties: {
            thread_id: THREAD_ID,
            turns: { type: 'integer', minimum: 1, maximum: SESSION_TOOL_LIMITS.readTurnsMax },
          },
          required: ['thread_id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.respond,
        description:
          'Explicitly answer a pending question or approval. Read the current request ID and permitted decisions first. Only your sub-sessions or a user-driven turn may respond. Secret inputs and executor-specific requests require the user. Ordinary send messages never answer pending requests.',
        inputSchema: {
          type: 'object',
          properties: {
            thread_id: THREAD_ID,
            request_id: { type: 'string' },
            answer: {
              type: 'object',
              description:
                'For approval: {decision: one of read.decisions}. For questions: {answers: {questionId: [answer strings]}}.',
            },
          },
          required: ['thread_id', 'request_id', 'answer'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.options,
        description:
          'List the harnesses on this device you can start sub-sessions on, with their models (the ids start takes as model), reasoning efforts and defaults, and this session’s current harness, model and effort. Call it before choosing a harness or model other than this session’s; do not guess model ids.',
        inputSchema: {
          type: 'object',
          properties: {
            harness: { type: 'string', description: 'Only this harness.' },
          },
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.start,
        description: startDescription(wrapUp, taskCards),
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title, under 60 characters.' },
            prompt: {
              type: 'string',
              description:
                'The task: what to do, the files or area, what done looks like. Required unless initiation is "offer".',
            },
            background: {
              type: 'string',
              description:
                'Required for fresh (ignored for fork; not for "offer"): context for someone who has not seen this conversation: the overall goal, decisions and constraints so far, how this piece fits in.',
            },
            harness: { type: 'string', description: 'Default: this session’s harness.' },
            model: {
              type: 'string',
              description:
                'Default: this session’s current model (the target harness’s default when the harness differs). To change it, pass a model id listed by options.',
            },
            effort: {
              type: 'string',
              description:
                'Reasoning effort. Default: this session’s current effort (the target harness’s default when the harness differs).',
            },
            cwd: { type: 'string', description: 'Default: this session’s folder.' },
            worktree: WORKTREE_PARAM,
            wake_parent: {
              type: 'boolean',
              description:
                'Default true. Allow eligible reports to wake this session. False still queues and delivers reports. Change later with set_wake; existing stop, failure and scheduled-turn rules still apply.',
            },
            kind: {
              type: 'string',
              enum: ['fresh', 'fork'],
              description:
                'fork copies this whole conversation (same harness only). Default fresh.',
            },
            initiation: {
              type: 'string',
              enum: taskCards ? ['user_asked', 'propose', 'offer'] : ['user_asked'],
            },
          },
          required: taskCards ? ['title'] : ['title', 'initiation'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.setWake,
        description:
          'Enable or disable automatic waking by one of your direct sub-sessions. Use wake:false for long-running work whose reports do not need your immediate attention; use wake:true when you need to follow its results. Reports are still queued, displayed and delivered, including to a running parent. Enabling rechecks eligible queued reports immediately under normal wake rules: it never overrides user stops, failed or interrupted turns, scheduled/user-started child turns, parent activity or wake limits. Other targets return forbidden, even on user-started turns.',
        inputSchema: {
          type: 'object',
          properties: { thread_id: THREAD_ID, wake: { type: 'boolean' } },
          required: ['thread_id', 'wake'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.send,
        description:
          'Send a message to a session: one of your sub-sessions, your parent session, any session that has exchanged a message with this one before (either direction, including ＠-mentions), or any session on a turn the user started. It is marked as coming from this session, not from the user.',
        inputSchema: {
          type: 'object',
          properties: { thread_id: THREAD_ID, message: { type: 'string' } },
          required: ['thread_id', 'message'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.wait,
        description:
          'Wait until the given sessions stop or the timeout passes, then return their status and last answers. Prefer ending your turn: you will be woken when your sub-sessions finish.',
        inputSchema: {
          type: 'object',
          properties: {
            // codex 交给模型时丢掉 maxItems、minimum、maximum（client-tools-specs.test.mts）：上限写进说明，模型才看得到
            thread_ids: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: `At most ${SESSION_TOOL_LIMITS.waitThreadsMax} sessions.`,
            },
            timeout_seconds: {
              type: 'integer',
              minimum: 1,
              maximum: SESSION_TOOL_LIMITS.waitSecondsMax,
              description: `Seconds to wait, 1 to ${SESSION_TOOL_LIMITS.waitSecondsMax}.`,
            },
          },
          required: ['thread_ids'],
          additionalProperties: false,
        },
      },
      ...(wrapUp && taskCards ? [WRAP_UP_TOOL] : []),
      {
        type: 'function',
        name: SESSION_TOOL.accept,
        description: taskCards
          ? 'Start one of your cards: a proposal the user told you to start in their latest message (for example "start the second one"; refused on turns the user did not start; it starts as proposed, with this session\'s current model and effort where the card has none), or an offer the user answered with "New session" (then pass the full brief: background and prompt, and harness, model, effort, cwd, kind when they differ from this session).'
          : 'Start one of the cards already in this conversation that the user told you to start in their latest message (for example "start the second one"; refused on turns the user did not start). It starts as proposed, with this session\'s current model and effort where the card has none.',
        inputSchema: {
          type: 'object',
          properties: {
            proposal_id: PROPOSAL_ID,
            prompt: {
              type: 'string',
              description:
                'Only for an answered offer: the task (what to do, files or area, what done looks like).',
            },
            background: {
              type: 'string',
              description:
                'Only for an answered offer, required for fresh: context for someone who has not seen this conversation (overall goal, decisions and constraints so far, how this piece fits in).',
            },
            title: { type: 'string', description: 'Only for an answered offer: a better title.' },
            harness: { type: 'string' },
            model: {
              type: 'string',
              description:
                'Default: this session’s current model (the target harness’s default when the harness differs). To change it, pass a model id listed by options.',
            },
            effort: {
              type: 'string',
              description:
                'Reasoning effort. Default: this session’s current effort (the target harness’s default when the harness differs).',
            },
            cwd: { type: 'string' },
            kind: { type: 'string', enum: ['fresh', 'fork'] },
          },
          required: ['proposal_id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.handOff,
        description:
          'Move the task you are in the middle of into its own session so you can answer a new, unrelated user message now. The new session is a fork of this conversation up to the previous turn, plus the remaining plan; it starts right away and wakes this session when it stops. After the call, stop that task here and answer the new message.',
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Names the task being moved, under 60 characters.',
            },
            remaining_plan: {
              type: 'string',
              description: 'What is left: steps, files, what done looks like.',
            },
            worktree: WORKTREE_PARAM,
          },
          required: ['title', 'remaining_plan'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.withdraw,
        description:
          'Withdraw a proposal card of yours that the user has not started: it was done here after all, is no longer needed, or you proposed a better one. If the user already started, dismissed it or it expired, the result says so; do not retry.',
        inputSchema: {
          type: 'object',
          properties: { proposal_id: PROPOSAL_ID },
          required: ['proposal_id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.interrupt,
        description:
          'Interrupt the running turn of one of your sub-sessions, or of any session on a turn the user started.',
        inputSchema: {
          type: 'object',
          properties: { thread_id: THREAD_ID },
          required: ['thread_id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.archive,
        description: `Archive a session on this device: it leaves the session list and stays in Archived with its conversation intact, where the user (or unarchive) can bring it back. A clean git worktree Litch created for it is removed (the branch stays); one with uncommitted changes is kept. Its sub-sessions that have stopped are archived with it; ones still working stay in the list. Pass "${SESSION_SELF}" to archive this session itself when this turn ends. Only call it after the user has explicitly agreed to archive that specific session, in a message they typed (refused on turns the user did not start); never speculatively. When your sub-sessions have all finished, you may ask the user whether to archive them and wait for their yes. A session that is still working (a turn running, waiting for the user, or background tasks running) or pinned is not archived, and the result says so.`,
        inputSchema: {
          type: 'object',
          properties: {
            thread_id: {
              type: 'string',
              description: `Session id (thread id) from list or start, or "${SESSION_SELF}" for this session.`,
            },
          },
          required: ['thread_id'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.unarchive,
        description:
          'Bring an archived session back to the session list, conversation intact (a worktree removed at archive is brought back). Use it when the user asks to restore a session. Your own sub-sessions can be restored any time; any other session only on a turn the user started.',
        inputSchema: {
          type: 'object',
          properties: { thread_id: THREAD_ID },
          required: ['thread_id'],
          additionalProperties: false,
        },
      },
    ],
  }
}

/** 客户端建会话时带的那份（收尾、任务卡都开着） */
export const SESSION_TOOLS: ClientToolNamespaceSpec = sessionTools(true)
