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
  /** fresh 的提案、直接起的 fresh 子会话，简报至少多少字：子会话只知道这一段 */
  freshPromptMinChars: 80,
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
  /** 子会话停下后叫醒这个会话，缺省 true */
  wake_parent?: boolean
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
 * 建议任务（提案卡片）的规矩：挂上 litch_sessions 时加进系统提示（命名空间的 instructions）。
 * 工具说明里只有一句话，模型不会主动提；什么时候该提、提几张、提了之后怎么办写在这里。
 */
export const SESSION_PROPOSAL_RULES = [
  'Suggested tasks (Litch). You can hand work to its own session as a suggested-task card: call litch_sessions.start with initiation "propose". The user sees the card in this conversation and starts it with one click, possibly on another harness, model or folder; nothing runs until then.',
  'When to propose (call the tool, do not just talk about it):',
  '- Your reply recommends next steps, lists remaining work, or calls something a follow-up, a separate change or "for later", and a step is real work that can run on its own: propose one card per such step in this same turn, before you finish. This holds even when the turn only answered a question or wrote some text.',
  '- Do not end with "Want me to ...?", "I can also ...", or "Shall I break this into tasks?" for that kind of work: the cards are how you offer it. Mention the cards in one line instead.',
  '- You notice independent or out-of-scope work while doing the task (a bug spotted in passing): propose it.',
  "- A plan has two or more fully independent steps that are real work (none needs another's result or touches the same files): say which one you take here, propose the others, then start yours right away.",
  'Not a card: small things (a quick question, a read, one small edit), which stay here; a task the user just asked you to do, which you do here, or start with initiation "user_asked" if they asked for a separate session; anything that first needs the user\'s decision, which you ask about, proposing the parts that do not depend on it.',
  `Limits: one card per independent piece, at most three per turn (four when splitting a plan), never the same piece twice, never work you are about to do yourself.`,
  'The prompt is everything a fresh session will know: the task, the files or area, and what done looks like, in your own words.',
  'Before you end every turn, check once: did my reply name follow-up work that should be a card? If so, propose it now.',
  'If the user tells you to start a card ("start the second one"), call litch_sessions.accept with its proposal_id. If a card went stale (done here after all, no longer needed, replaced by a better one), withdraw it with litch_sessions.withdraw; propose the replacement first.',
].join('\n')

const THREAD_ID = { type: 'string', description: 'Session id (thread id) from list or start.' }
const PROPOSAL_ID = { type: 'string', description: 'proposal_id returned by start.' }

export const SESSION_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.sessions,
  description:
    'Litch sessions on this device. A sub-session is a full, separate session the user can open and talk to; use it for independent work the user also wants to follow, or work that needs another harness, model or folder. For quick lookups inside this task, use your own subagents instead. Real follow-up work you would otherwise only mention belongs in a proposal card (start with initiation "propose"). Results of your sub-sessions arrive later as a <litch-session-event> message; do not poll. You can only send to or interrupt your own sub-sessions. Never answer approvals or questions waiting inside a sub-session: only the user can.',
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
      description: `Start a sub-session, or propose one. Only use initiation "user_asked" when the user asked for it in their latest message; otherwise the user gets a proposal card in this conversation and nothing runs until they start it (at most ${SESSION_TOOL_LIMITS.proposalsPerTurn} proposals per turn). The prompt is all a fresh sub-session knows: state the task, the files, and what done looks like (at least ${SESSION_TOOL_LIMITS.freshPromptMinChars} characters).`,
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
          wake_parent: {
            type: 'boolean',
            description: 'Wake this session when the sub-session stops. Default true.',
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
