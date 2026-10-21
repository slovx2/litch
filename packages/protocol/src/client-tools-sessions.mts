// litch_sessions：模型列出、读取同一台设备上的会话，派出子会话，给自己的子会话发消息、打断，等它们结束。
// 和 litch_browser 这些不同，执行方是设备进程自己，不是桌面端（会话在设备上）：建会话时带不带它看的是
// 设备信息的 extensions 有没有 sessionTree、设置里“会话编排”开没开，不看桌面端的声明；设备进程替每条
// 通往引擎的连接声明能执行它，调用到了设备进程就自己答，不转给任何客户端。父子关系、提案见 session-tree.mts，
// 规矩写在 protocol/extensions/session-tree.json。说明是写给模型看的，用英文。
//
// 这个文件只引用 client-tools.mts 和 session-tree.mts。
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientToolFunctionSpec,
  type ClientToolNamespaceSpec,
} from './client-tools.mjs'
import type { SessionLineageKind } from './session-tree.mjs'

export const SESSION_TOOL = {
  list: 'list',
  read: 'read',
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
} as const

export type SessionToolName = (typeof SESSION_TOOL)[keyof typeof SESSION_TOOL]

export const SESSION_TOOL_LIMITS = {
  /** list 最多回多少个 */
  listMax: 50,
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

export interface SessionsReadArguments {
  thread_id: string
  /** 最近几个回合 */
  turns?: number
}

export interface SessionsStartArguments {
  title: string
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
   * 和按钮一起画在回合最下方，下一条用户消息之后失效
   */
  ask?: string
  /** ask 的回复按钮，1 到 wrapUpActions 个，第一个是推荐的；没有 ask 时不给 */
  actions?: SessionsWrapUpAction[]
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
  /** 是不是调用者自己派出的子孙 */
  mine: boolean
}

export interface SessionsListResult {
  sessions: SessionSummary[]
  /** 没列全时为 true */
  truncated: boolean
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

/**
 * 建议任务（提案卡片）的规矩：挂上 litch_sessions 时加进系统提示（命名空间的 instructions）。
 * 只靠规则模型不会主动提（16 号设计第 0 条的验收），所以每回合收尾必须调 wrap_up，建议放在它的参数里；
 * 用户发起的回合没调，设备进程会再开一个回合提醒（SessionEventKind 的 remind）。
 * 顺序照 Claude 桌面端：先收尾、再写最终回答。反过来的话回合最后一段是“回答已经给你了”这种短话，
 * 只认最后一段为回答的界面会把真正的回答收进过程。
 * wrapUp 是设置里“每回合收尾”的开关（设备进程按它换掉客户端给的这组工具）：关掉时没有 wrap_up 这个工具，
 * 规则里也不提收尾，建议改用 start 的 propose。
 */
export function sessionProposalRules(wrapUp: boolean): string {
  return [
    'Separate sessions and suggested tasks (Litch). Work can go to its own session, possibly on another harness, model or folder: the user starts it with one click on a card in this conversation; nothing runs until then.',
    'Before acting on a request, decide what it is to this session:',
    "- A continuation: anything that builds on what was done, found or decided here (a correction, a follow-up, a question, the next iteration, going ahead with what you just investigated or suggested), and anything a few tool calls settle, whatever it is about. Do it here. When unsure, it is a continuation: a wrong offer stops the user's work, a wrong continuation only makes this session a little longer.",
    '- A new task: unrelated work that a fresh session would do just as well from the user\'s words alone, because it builds on nothing done, found or decided here. Your first action is litch_sessions.start with initiation "offer" and a title only, with no other tool call and no plan before it: the user gets a "New session / Do it here" card and the call waits for their choice. If they choose a new session, call litch_sessions.accept with the proposal_id and the full brief; if they choose here, do it here.',
    '- The user asked in words for separate, parallel or background work, or told you to start a piece now: litch_sessions.start with initiation "user_asked", one session per independent piece.',
    'While you work, suggest what you notice or conclude on your own: independent or out-of-scope work, a fix spotted in passing, the follow-up your answer recommends (also when the turn only answered a question). One card per independent piece, at most ' +
      `${SESSION_TOOL_LIMITS.proactivePerTurn} per turn, never the same piece twice, never what you are about to do anyway. A task the user's message tells you to do is never one of these: it is a continuation, a new task or user_asked.`,
    'A follow-up you name gets a card, not just a sentence: when your reply calls some work a follow-up, a separate change or "for later", and it is real work worth doing next in its own session (not a one-line tweak or speculation), suggest it before the turn ends. The card is how you ask for the user\'s OK, so do not leave it as "want me to ...?" or "needs your OK" in prose; mention the cards in one line.',
    `After the user accepts a plan, check whether two or more of its steps are real work that can each run on its own: none needs another step's result or changes already made in this session, none is needed by another step, none touches files another step touches, none must land in one change with another. A last step that only checks the finished work does not count. When at least two pass and the user has not said where to run them, say in one line which step you start on, and propose each of the others right away with litch_sessions.start (initiation "propose"), at most ${SESSION_TOOL_LIMITS.proposalsPerTurn}. Right before you begin a step you proposed, withdraw its card; if the user already started it, leave that step to its session.`,
    "Not for a card: quick things (a question, a read, one edit, a handful of tool calls), which stay here; anything that first needs the user's decision, which you ask about, suggesting only the parts that do not depend on it.",
    'If a new user message about something unrelated arrives while you are in the middle of a task, hand that task off with litch_sessions.hand_off (a title and the remaining plan: steps, files, what done looks like), then answer the new message. A small correction is not that: just adjust. If the user said to keep working here, keep it here.',
    wrapUp
      ? 'Every turn ends with litch_sessions.wrap_up and then your final answer, in that order. When the work is done (in a turn that only answers a question: before you write the answer), call wrap_up exactly once. Part of wrapping up is deciding, unasked, whether the request left real follow-up work that belongs in its own session: the next step the request implies, a piece you left or could not verify, the part that can run while the user reviews the rest, something the user set aside earlier, or a self-contained next task better started fresh than from a long history; never work unrelated to the request. Pass those in suggestions (skip ones you already proposed this turn), or an empty list. Then write your final answer to the user as the last message of the turn: complete on its own, never a summary of or a pointer to text above it, because what came before wrap_up is shown folded as work in progress. If you skip wrap_up, Litch reminds you in a new message.'
      : 'To suggest work, call litch_sessions.start with initiation "propose": each call makes one card the user can start; nothing runs until they do. Write your final answer to the user as the last message of the turn.',
    `A fresh session sees nothing of this conversation: it gets only the two parts of its brief, written in your own words for someone who has not read any of this. background: the overall goal, what has been decided or ruled out so far, the constraints to respect, and how this piece fits in (at least ${SESSION_TOOL_LIMITS.freshBackgroundMinWidth} wide; a CJK character counts as 2). prompt: the task itself, the files or area, and what done looks like. A fork already has this conversation, so it needs only the prompt. Follow-ups for a session you started go to it with litch_sessions.send, not to a new session.`,
    'Right before each litch_sessions.start or hand_off, write a bold title line and one sentence on what it will do.',
    'If the user tells you to start a card ("start the second one"), call litch_sessions.accept with its proposal_id. If a card went stale (done here after all, no longer needed, replaced by a better one), withdraw it with litch_sessions.withdraw; propose the replacement first.',
  ].join('\n')
}

/** 收尾开着（默认）时的规则：客户端带的就是这一份 */
export const SESSION_PROPOSAL_RULES = sessionProposalRules(true)

const THREAD_ID = { type: 'string', description: 'Session id (thread id) from list or start.' }
const PROPOSAL_ID = { type: 'string', description: 'proposal_id returned by start.' }

/** 收尾：每回合干完活先调它、再写最终回答（设置里“每回合收尾”关掉时不给） */
const WRAP_UP_TOOL: ClientToolFunctionSpec = {
  type: 'function',
  name: SESSION_TOOL.wrapUp,
  description: `Call this exactly once in every turn, when the work is done and before your final answer, even when there is nothing to suggest (pass an empty list); then write the final answer as the last message of the turn, complete on its own (not a summary of or a pointer to text above). First decide, unasked, whether the request left real follow-up work for its own session: the next step it implies, a piece you left or could not verify, the part that can run while the user reviews the rest, something the user set aside earlier, or a self-contained next task better started fresh; never unrelated work. Each suggestion becomes a card the user can start; nothing runs until they do. At most ${SESSION_TOOL_LIMITS.proposalsPerTurn} cards per turn, counting start proposals.`,
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
                'Default: this session’s current model (the target harness’s default when the harness differs).',
            },
            effort: {
              type: 'string',
              description:
                'Reasoning effort. Default: this session’s current effort (the target harness’s default when the harness differs).',
            },
            cwd: { type: 'string', description: 'Default: this session’s folder.' },
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
        description: `Only when this turn leaves the user one decision (for example whether to go ahead here with what you just found): that one short question, under ${SESSION_TOOL_LIMITS.askChars} characters. Omit when nothing waits on the user.`,
      },
      actions: {
        type: 'array',
        description: `Reply buttons answering ask, 1 to ${SESSION_TOOL_LIMITS.wrapUpActions}, your recommendation first. A click sends message (or the label) back to you as the user's words.`,
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: `Button text, 1-3 words, under ${SESSION_TOOL_LIMITS.actionLabelChars} characters.`,
            },
            message: {
              type: 'string',
              description: `What the click sends, under ${SESSION_TOOL_LIMITS.actionMessageChars} characters. Omit when the label says it all.`,
            },
          },
          required: ['label'],
          additionalProperties: false,
        },
      },
    },
    required: ['suggestions'],
    additionalProperties: false,
  },
}

/**
 * litch_sessions 这组工具。wrapUp 跟着设置里“每回合收尾”的开关：客户端带的是开着的那份（SESSION_TOOLS），
 * 设备进程建会话时按设置换成对应的那份（session-tools.mts 的 currentSessionTools）
 */
export function sessionTools(wrapUp: boolean): ClientToolNamespaceSpec {
  return {
    type: 'namespace',
    name: CLIENT_TOOL_NAMESPACE.sessions,
    description: `Litch sessions on this device. A sub-session is a full, separate session the user can open and talk to; use it for independent work the user also wants to follow, or work that needs another harness, model or folder. For quick lookups inside this task, use your own subagents instead. ${wrapUp ? 'Every turn ends with wrap_up and then your final answer; real follow-up work goes into its suggestions as cards.' : 'Real follow-up work becomes a card with start (initiation "propose").'} A new task unrelated to this session starts with an offer (start, initiation "offer"). Results of your sub-sessions arrive later as a <litch-session-event> message; do not poll. You can only send to or interrupt your own sub-sessions. Never answer approvals or questions waiting inside a sub-session: only the user can.`,
    instructions: sessionProposalRules(wrapUp),
    tools: [
      {
        type: 'function',
        name: SESSION_TOOL.list,
        description: 'List sessions on this device, newest first.',
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
          'Read a session’s status and its last few turns (input and final answer, trimmed) without opening it.',
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
        name: SESSION_TOOL.start,
        description:
          `Start a sub-session, propose one, or offer a new session. initiation "user_asked": the user asked for separate work in their latest message; it starts now. "propose" (default): a card the user may start; nothing runs until they do (at most ${SESSION_TOOL_LIMITS.proposalsPerTurn} cards per turn). "offer": the user's latest message is a new task unrelated to this session; send the title only, as the only call in that message; the card asks the user "New session" or "Do it here" and the call waits for the answer, which tells you what to do next. A fresh sub-session knows only background and prompt: background gives the context it cannot see (at least ${SESSION_TOOL_LIMITS.freshBackgroundMinWidth} wide; a CJK character counts as 2), prompt the task. ${wrapUp ? 'To suggest work at the end of a turn, use wrap_up instead.' : ''}`.trimEnd(),
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
                'Default: this session’s current model (the target harness’s default when the harness differs).',
            },
            effort: {
              type: 'string',
              description:
                'Reasoning effort. Default: this session’s current effort (the target harness’s default when the harness differs).',
            },
            cwd: { type: 'string', description: 'Default: this session’s folder.' },
            kind: {
              type: 'string',
              enum: ['fresh', 'fork'],
              description:
                'fork copies this whole conversation (same harness only). Default fresh.',
            },
            initiation: { type: 'string', enum: ['user_asked', 'propose', 'offer'] },
          },
          required: ['title'],
          additionalProperties: false,
        },
      },
      {
        type: 'function',
        name: SESSION_TOOL.send,
        description:
          'Send a message to one of your sub-sessions. It is marked as coming from this session, not from the user.',
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
      ...(wrapUp ? [WRAP_UP_TOOL] : []),
      {
        type: 'function',
        name: SESSION_TOOL.accept,
        description:
          'Start one of your cards: a proposal the user told you to start in their latest message (for example "start the second one"; refused on turns the user did not start), or an offer the user answered with "New session" (then pass the full brief: background and prompt, and harness, model, cwd, kind when they differ from this session).',
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
                'Default: this session’s current model (the target harness’s default when the harness differs).',
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
        description: 'Interrupt the running turn of one of your sub-sessions.',
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

/** 客户端建会话时带的那份（收尾开着） */
export const SESSION_TOOLS: ClientToolNamespaceSpec = sessionTools(true)
