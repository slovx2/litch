// 经理工具与英文规则。只声明契约和拼接文字，不执行看板、会话或文件操作。
import { CLIENT_TOOL_NAMESPACE, type ClientToolNamespaceSpec } from './client-tools.mjs'
import {
  archiveRule,
  FRESH_BRIEF,
  outsideLitch,
  TITLE_LINE,
  WORKTREE_RULE,
} from './client-tools-sessions.mjs'
import type {
  ManagerBoard,
  ManagerChange,
  ManagerDecision,
  ManagerDecisionFields,
  ManagerDecisionId,
  ManagerDispatchSettings,
  ManagerItem,
  ManagerItemFields,
  ManagerItemId,
  ManagerObjectId,
  ManagerSituation,
  ManagerTemplate,
} from './manager.mjs'

export const MANAGER_TOOL = {
  summary: 'summary',
  get: 'get',
  add: 'add',
  update: 'update',
  verify: 'verify',
  close: 'close',
  answer: 'answer',
  status: 'status',
} as const

/** 第 6 层答复事件的指令；实际成功项由设备放到 SessionEvent.manager.answers。 */
export const MANAGER_ANSWERS_TEXT =
  'Apply these board answers to the plan, notify affected lines with litch_sessions.send, land lasting decisions under project rules, record their locations, and update items and the situation. Do not ask these questions again.'

/** 第 1 层：固定部分约 800 token；scope 原样插入，用户规矩另放最后。 */
export function managerRoleRules(scope: string): string {
  return [
    `You are a Litch manager. The user discusses and decides here; delegate implementation to sub-sessions. Your scope: ${scope}. This is a long-lived conversation: keep lasting information in the board or repository, not only in chat.`,
    'Your work: clarify intent, split and prioritize items, start lines, follow up, check reports, finish work, record decisions for the user and maintain the board. Read code and documents to brief and review. Do not implement code yourself; start a line. Follow the user’s stated division of decisions; when unclear, create a decision. Answer small questions yourself after checking; record any resulting work as items.',
    'Each turn: identify what arrived (user message, board answers, line reports, Litch events). Apply answers to the plan, notify affected lines with litch_sessions.send, land lasting decisions in the repository under project rules and record their location with update. Check reports before changing item status. Split new requests into items; start in-scope work and raise out-of-scope work as decisions. Update items and use status when the situation materially changes. On user turns, say what changed, what is blocked and what the user needs to do; mention decision titles only, with details on the board. For report-only or event-only turns, update the ledger and reply in one or two sentences.',
    'Ask the user through board decisions, not question lists or suggestion cards in chat. One decision asks one question, with that question as its title. Background must stand alone; give options and a recommendation when useful, what happens without an answer, and basis (files, branches, sessions). Record answers already given in chat with answer; do not ask again. If a question is no longer needed, close it with a reason; never close an answered decision. Prioritize and consolidate excessive pending questions.',
    'Lines cannot see this conversation: make briefs self-contained. Turn scope or product questions in reports into decisions yourself. Serialize or combine lines changing the same files. If a line fails or stalls, reassign or send guidance where possible; raise decisions for the user, or mark an item blocked with a reason. Do not leave stalled lines unattended. Check branches, commits and check results rather than trusting completion claims. Record unverified work on items; create user-owned items for checks only the user can do (real devices, windows, login), instead of marking them done.',
    'The board records the process; the repository is authoritative. Check the recorded basis before acting; reconcile the board with the repository. Use verify after checking that an object remains valid.',
  ].join('\n\n')
}

/** 第 2 层：替换任务卡规则。设备还须换掉 start/命名空间的普通会话说明并移除 wrap_up。 */
export function managerSessionRules(maxRunningLines: number): string {
  return [
    'Manager sessions (Litch). For in-scope items, call litch_sessions.start with initiation "user_asked" directly: creating this manager authorized this delegation, including event turns. Raise out-of-scope work as a board decision first.',
    `Keep at most ${maxRunningLines} lines running across your entire subtree, including waiting approvals and background work. The device rejects starts or resumes beyond this limit; finish or stop an existing line first.`,
    'Do not call wrap_up or offer suggestion cards. Put decisions on the board and follow-up work in items. When the user asks to move the current task to another session, retain litch_sessions.hand_off.',
    FRESH_BRIEF,
    WORKTREE_RULE,
    TITLE_LINE,
    archiveRule(false),
    'Put the archival question on the board as a decision; do not ask it separately in chat.',
    outsideLitch(false),
  ].join('\n\n')
}

/** 第 7 层：派活默认参数由设备执行；文字只告诉线与自身有关的工作树和合并约束。 */
export function managerLineRules(name: string, dispatch: ManagerDispatchSettings): string {
  return [
    `You are a line started by manager "${name}". The manager works with the user; you finish this assignment.`,
    'For unclear scope or product details, do not stop waiting for the user: complete what you safely can and report the questions to the manager. Permission approvals still go through the normal user approval path.',
    'At the end of each turn, report: what you did; branch, commits and whether you pushed; checks and results; each unverified part on its own line starting exactly with "没验："; decisions needed from the manager.',
    'Do not merge, push or release unless the brief explicitly authorizes it. You do not inherit litch_manager; report board changes to the manager.',
    dispatch.worktree
      ? 'Code work uses the worktree assigned in your brief; do not create a second worktree.'
      : 'Code work shares a folder; respect the brief’s file ownership and preserve other lines’ edits.',
    dispatch.merge === 'manager'
      ? 'Report acceptance evidence to the manager for integration.'
      : 'Leave integration to the user and report readiness to the manager.',
  ].join('\n')
}

/** 规矩更新由设备送事件，用户原文保留，覆盖当前上下文里的旧范围与旧规矩。 */
export function managerRulesText(scope: string, rules: string): string {
  return [
    'The user changed this manager’s settings. The following scope and custom rules replace the previous ones. Apply them to the current work and future planning.',
    `Current scope:\n${scope}`,
    rules
      ? `Current custom rules:\n${rules}`
      : 'The user cleared the custom rules; no previous custom rules remain in effect.',
  ].join('\n\n')
}

/** 第 9 层：有第一件事时按用户原文执行；默认开场必须等用户说开始。由设备包成 manager-open 事件。 */
export function managerOpenText(scope: string, firstTask = ''): string {
  return firstTask.trim()
    ? `The user supplied this first task for the manager. Follow it within scope (${scope}):\n\n${firstTask}`
    : `Plan the first items for this scope: ${scope}. Put questions needing the user on the board as decisions, and present a plan. Do not start lines yet; wait for the user to say to begin.`
}

/** 第 9 层：结束回合专用；线的归档仍须用户明确同意。 */
export function managerEndText(template: ManagerTemplate): string {
  return [
    'The user is ending this manager. Write a summary with completed work, unfinished work, and remaining decisions and items; save it with status. Land decided but unrecorded outcomes in the repository under project rules and record their locations. Leave unresolved objects as they are. Do not start new lines.',
    template === 'release' ? 'Include a draft of release notes in the summary.' : '',
    'During this finalization turn, use status for the summary, close obsolete open decisions, update items and decision landed locations, and verify existing objects. Do not add new board objects or record new answers. Ask whether the user wants your lines archived directly in your final reply; do not archive them without explicit agreement. The board becomes read-only after this finalization turn.',
  ]
    .filter(Boolean)
    .join('\n')
}

export type ManagerAddArguments =
  | {
      kind: 'decision'
      decision: Pick<ManagerDecisionFields, 'title' | 'background'> & Partial<ManagerDecisionFields>
    }
  | { kind: 'item'; item: Pick<ManagerItemFields, 'title'> & Partial<ManagerItemFields> }
export type ManagerUpdateArguments =
  | { kind: 'decision'; id: ManagerDecisionId; patch: Partial<ManagerDecisionFields>; why: string }
  | { kind: 'item'; id: ManagerItemId; patch: Partial<ManagerItemFields>; why: string }
export interface ManagerVerifyArguments {
  id: ManagerObjectId
  commit: string | null
  why: string
}
export type ManagerCloseArguments =
  | { kind: 'decision'; id: ManagerDecisionId; status: 'expired' | 'withdrawn'; reason: string }
  | { kind: 'item'; id: ManagerItemId; status: 'done' | 'deferred'; reason: string }
export interface ManagerAnswerArguments {
  id: ManagerDecisionId
  optionId: string | null
  text: string
}

/** 工具的请求与 JSON 结果；执行器以调用会话识别看板，所有方法均不接收 managerId。 */
export interface ManagerToolArguments {
  summary: Record<string, never>
  get: { id: ManagerObjectId }
  add: ManagerAddArguments
  update: ManagerUpdateArguments
  verify: ManagerVerifyArguments
  close: ManagerCloseArguments
  answer: ManagerAnswerArguments
  status: { text: string }
}
export interface ManagerToolResults {
  summary: Pick<ManagerBoard, 'situation' | 'decisions' | 'items' | 'lines'>
  get: { object: ManagerDecision | ManagerItem; changes: ManagerChange[] }
  add: { id: ManagerObjectId; object: ManagerDecision | ManagerItem }
  update: { object: ManagerDecision | ManagerItem }
  verify: { object: ManagerDecision | ManagerItem }
  close: { object: ManagerDecision | ManagerItem }
  answer: { object: ManagerDecision }
  status: { situation: ManagerSituation }
}

// 顶层保持普通对象，避免 Claude 丢弃工具；kind 对应关系、跨字段引用与状态流转由设备校验。
const STRING = { type: 'string' }
const KIND = { type: 'string', enum: ['decision', 'item'] }
const NULLABLE_STRING = { type: ['string', 'null'] }
const STRINGS = { type: 'array', items: STRING }
const ID = { type: 'string', description: 'Board object id: D-<n> or I-<n>.' }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const LINKS = {
  type: 'array',
  items: object(
    {
      kind: { type: 'string', enum: ['file', 'branch', 'commit', 'thread', 'url'] },
      target: STRING,
      label: NULLABLE_STRING,
    },
    ['kind', 'target', 'label'],
  ),
}
const OWNER = {
  anyOf: [
    object({ kind: { type: 'string', enum: ['manager', 'user'] } }, ['kind']),
    object({ kind: { type: 'string', const: 'line' }, threadId: STRING }, ['kind', 'threadId']),
  ],
}
const DECISION_FIELDS = {
  title: STRING,
  background: STRING,
  options: {
    type: 'array',
    items: object({ id: STRING, label: STRING, description: STRING }, [
      'id',
      'label',
      'description',
    ]),
  },
  recommend: { ...NULLABLE_STRING, description: 'Option id, or null for no recommendation.' },
  default: {
    description:
      'No-answer intent only; this version always waits and never applies an option automatically.',
    anyOf: [
      object({ kind: { type: 'string', const: 'ask' } }, ['kind']),
      object({ kind: { type: 'string', const: 'option' }, optionId: STRING }, ['kind', 'optionId']),
    ],
  },
  blocks: { ...STRINGS, description: 'Ids of items blocked by this decision.' },
  links: LINKS,
  basis: LINKS,
  landed: LINKS,
}
const ITEM_FIELDS = {
  title: STRING,
  status: {
    type: 'string',
    enum: ['backlog', 'running', 'review', 'done', 'deferred', 'blocked'],
  },
  owner: OWNER,
  blockedBy: { ...STRINGS, description: 'Decision ids. Set why for a blocked item.' },
  why: STRING,
  links: LINKS,
  basis: LINKS,
  unverified: STRINGS,
}

export const MANAGER_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.manager,
  description:
    'The current Litch manager’s device-local board. Read a summary or object; record decisions, items, checks, user answers and the situation. The repository is authoritative. Lines and activity are derived by Litch; use litch_sessions for delegation. This namespace belongs only to the manager, not its lines. Long-lived role and session rules are supplied separately in instructions.',
  tools: [
    {
      type: 'function',
      name: MANAGER_TOOL.summary,
      description: 'Read current situation, open decisions, unfinished items and running lines.',
      inputSchema: object({}),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.get,
      description: 'Read one decision or item with full fields and change history.',
      inputSchema: object({ id: ID }, ['id']),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.add,
      description:
        'Add a decision or item; returns its id and object. Omitted arrays are empty; a decision starts open, recommend null, default ask; an item starts backlog, owner manager, why empty.',
      inputSchema: object(
        {
          kind: {
            ...KIND,
            description: 'For decision, supply only decision; for item, supply only item.',
          },
          decision: object(DECISION_FIELDS, ['title', 'background']),
          item: object(ITEM_FIELDS, ['title']),
        },
        ['kind'],
      ),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.update,
      description:
        'Patch supplied fields and record why. Arrays replace whole arrays; null clears recommend. Use answer/close for decision transitions and verify for checked. Cannot write line facts.',
      inputSchema: object(
        {
          kind: KIND,
          id: ID,
          patch: {
            description:
              'Nonempty fields for the selected kind: decision uses the first shape, item the second. Do not mix them.',
            anyOf: [object(DECISION_FIELDS), object(ITEM_FIELDS)],
          },
          why: STRING,
        },
        ['kind', 'id', 'patch', 'why'],
      ),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.verify,
      description:
        'Record that you checked the basis and it is still valid. Device timestamps checked.',
      inputSchema: object({ id: ID, commit: NULLABLE_STRING, why: STRING }, [
        'id',
        'commit',
        'why',
      ]),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.close,
      description:
        'Close an open decision as expired/withdrawn, or finish/defer an item. Give a nonempty reason. Never close an answered decision.',
      inputSchema: object(
        {
          kind: KIND,
          id: ID,
          status: {
            type: 'string',
            enum: ['expired', 'withdrawn', 'done', 'deferred'],
            description: 'For decision: expired or withdrawn. For item: done or deferred.',
          },
          reason: STRING,
        },
        ['kind', 'id', 'status', 'reason'],
      ),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.answer,
      description:
        'Record an answer the user already gave in conversation, as user-conversation. Supply an option id or nonempty text (or both). Only open decisions; never invent the user’s answer.',
      inputSchema: object({ id: ID, optionId: NULLABLE_STRING, text: STRING }, [
        'id',
        'optionId',
        'text',
      ]),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.status,
      description:
        'Replace the current situation with a short account of material progress; device timestamps it.',
      inputSchema: object({ text: STRING }, ['text']),
    },
  ],
}
