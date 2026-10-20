// litch_sessions：模型列出、读取同一台设备上的会话，派出子会话，给自己的子会话发消息、打断，等它们结束。
// 和 litch_browser 这些不同，执行方是设备进程自己，不是桌面端（会话在设备上）：建会话时带不带它看的是
// 设备信息的 extensions 有没有 sessionTree、设置里“会话编排”开没开，不看桌面端的声明；设备进程替每条
// 通往引擎的连接声明能执行它，调用到了设备进程就自己答，不转给任何客户端。父子关系、提案见 session-tree.mts，
// 规矩写在 protocol/extensions/session-tree.json。说明是写给模型看的，用英文。
//
// 这个文件只引用 client-tools.mts 和 session-tree.mts。
import { CLIENT_TOOL_NAMESPACE, type ClientToolNamespaceSpec } from './client-tools.mjs'
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
  /** send 的消息、start 的 prompt 最多多少字 */
  messageChars: 32_000,
  /** 一个回合里最多提几张提案（规则里写平时三张，计划拆分时四张） */
  proposalsPerTurn: 4,
  /** fresh 的提案、直接起的 fresh 子会话，简报至少多宽（textWidth：汉字等宽字符算 2）：子会话只知道这一段 */
  freshPromptMinWidth: 80,
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
  /** 子会话收到的第一段话：任务、相关文件、做完的标准。子会话看不到这个会话的内容（fork 除外） */
  prompt: string
  /** 不给是这个会话的 harness */
  harness?: string
  model?: string
  /** 不给是这个会话的目录 */
  cwd?: string
  /** 缺省 fresh。fork 带上这个会话的全部上下文，只能同 harness */
  kind?: SessionLineageKind
  /**
   * user_asked：用户在这个回合里亲口要求起这个会话，直接起（设备进程还要核对这个回合确实是用户发起的，
   * 不是就降成提案）；propose（缺省）：出一张提案卡片，用户点了才起
   */
  initiation?: 'user_asked' | 'propose'
}

export interface SessionsAcceptArguments {
  proposal_id: string
}

export interface SessionsWithdrawArguments {
  proposal_id: string
}

/** wrap_up 里的一条建议：和 start 的提案一样，只是不能直接起 */
export interface SessionsSuggestion {
  title: string
  prompt: string
  harness?: string
  model?: string
  cwd?: string
  kind?: SessionLineageKind
}

export interface SessionsWrapUpArguments {
  /** 没有建议时是空数组；最多 proposalsPerTurn 条（和这回合里 start 提的合起来算） */
  suggestions: SessionsSuggestion[]
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
  /** 降成了提案：提案号 */
  proposal_id?: string
  /** 给模型的一句话：起了、还是等用户点 */
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
 */
export const SESSION_PROPOSAL_RULES = [
  'Suggested tasks (Litch). The user can hand work to its own session from a suggested-task card in this conversation: one click starts it, possibly on another harness, model or folder; nothing runs until then.',
  'End every turn by calling litch_sessions.wrap_up, as your last action, exactly once. Pass the suggested tasks of this turn in suggestions, or an empty list when there are none. If you skip it, Litch reminds you in a new message.',
  'What to put in suggestions:',
  '- Every step your reply recommends, every piece of remaining work you listed, and anything you called a follow-up, a separate change or "for later", when it is real work that can run on its own. This holds even when the turn only answered a question or wrote some text.',
  '- Independent or out-of-scope work you noticed while doing the task (a bug spotted in passing).',
  "- When a plan has two or more fully independent steps that are real work (none needs another's result or touches the same files): the steps you are not taking here.",
  'Not a suggestion: small things (a quick question, a read, one small edit), which stay here; a task the user just asked you to do, which you do here, or start with litch_sessions.start (initiation "user_asked") if they asked for a separate session; anything that first needs the user\'s decision, which you ask about, suggesting the parts that do not depend on it.',
  `Do not end with "Want me to ...?" or "Shall I break this into tasks?" for that kind of work: the cards are how you offer it; mention them in one line. One card per independent piece, at most ${SESSION_TOOL_LIMITS.proposalsPerTurn} per turn, never the same piece twice, never work you are about to do yourself.`,
  'Each prompt is everything a fresh session will know: the task, the files or area, and what done looks like, in your own words.',
  'If the user tells you to start a card ("start the second one"), call litch_sessions.accept with its proposal_id. If a card went stale (done here after all, no longer needed, replaced by a better one), withdraw it with litch_sessions.withdraw; suggest the replacement first.',
].join('\n')

const THREAD_ID = { type: 'string', description: 'Session id (thread id) from list or start.' }
const PROPOSAL_ID = { type: 'string', description: 'proposal_id returned by start.' }

export const SESSION_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.sessions,
  description:
    'Litch sessions on this device. A sub-session is a full, separate session the user can open and talk to; use it for independent work the user also wants to follow, or work that needs another harness, model or folder. For quick lookups inside this task, use your own subagents instead. End every turn with wrap_up; real follow-up work goes into its suggestions as cards. Results of your sub-sessions arrive later as a <litch-session-event> message; do not poll. You can only send to or interrupt your own sub-sessions. Never answer approvals or questions waiting inside a sub-session: only the user can.',
  instructions: SESSION_PROPOSAL_RULES,
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
      description: `Start a sub-session, or propose one. Only use initiation "user_asked" when the user asked for it in their latest message; otherwise the user gets a proposal card in this conversation and nothing runs until they start it (at most ${SESSION_TOOL_LIMITS.proposalsPerTurn} proposals per turn). The prompt is all a fresh sub-session knows: state the task, the files, and what done looks like (at least ${SESSION_TOOL_LIMITS.freshPromptMinWidth} characters; a CJK character counts as 2). To suggest work at the end of a turn, use wrap_up instead.`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title, under 60 characters.' },
          prompt: { type: 'string', description: 'First message for the sub-session.' },
          harness: { type: 'string', description: 'Default: this session’s harness.' },
          model: { type: 'string' },
          cwd: { type: 'string', description: 'Default: this session’s folder.' },
          kind: {
            type: 'string',
            enum: ['fresh', 'fork'],
            description: 'fork copies this whole conversation (same harness only). Default fresh.',
          },
          initiation: { type: 'string', enum: ['user_asked', 'propose'] },
        },
        required: ['title', 'prompt'],
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
    {
      type: 'function',
      name: SESSION_TOOL.wrapUp,
      description: `Call this exactly once at the end of every turn, as your last action, even when there is nothing to suggest (pass an empty list). Each suggestion becomes a suggested-task card the user can start; nothing runs until they do. At most ${SESSION_TOOL_LIMITS.proposalsPerTurn} per turn.`,
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
                  description: `The brief: task, files or area, what done looks like (at least ${SESSION_TOOL_LIMITS.freshPromptMinWidth} characters for fresh; a CJK character counts as 2).`,
                },
                harness: { type: 'string', description: 'Default: this session’s harness.' },
                model: { type: 'string' },
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
        },
        required: ['suggestions'],
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: SESSION_TOOL.accept,
      description:
        'Start one of your proposal cards because the user told you to in their latest message (for example "start the second one"). Refused on turns the user did not start.',
      inputSchema: {
        type: 'object',
        properties: { proposal_id: PROPOSAL_ID },
        required: ['proposal_id'],
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
