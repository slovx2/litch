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

export interface SessionsWaitResult {
  /** 到点还没停的也在里面，status 是 running */
  sessions: (SessionSummary & { last_answer: string | null })[]
  timed_out: boolean
}

const THREAD_ID = { type: 'string', description: 'Session id (thread id) from list or start.' }

export const SESSION_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.sessions,
  description:
    'Litch sessions on this device. A sub-session is a full, separate session the user can open and talk to; use it for independent work the user also wants to follow, or work that needs another harness, model or folder. For quick lookups inside this task, use your own subagents instead. Results of your sub-sessions arrive later as a <litch-session-event> message; do not poll. You can only send to or interrupt your own sub-sessions. Never answer approvals or questions waiting inside a sub-session: only the user can.',
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
        'Start a sub-session. Only use initiation "user_asked" when the user asked for it in their latest message; otherwise the user gets a proposal card and nothing runs until they accept. The prompt is all a fresh sub-session knows: state the task, the files, and what done looks like.',
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
          thread_ids: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: SESSION_TOOL_LIMITS.waitThreadsMax,
          },
          timeout_seconds: {
            type: 'integer',
            minimum: 1,
            maximum: SESSION_TOOL_LIMITS.waitSecondsMax,
          },
        },
        required: ['thread_ids'],
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
