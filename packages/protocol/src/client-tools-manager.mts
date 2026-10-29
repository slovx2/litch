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
  ManagerContactSettings,
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
    'The board records the process; the repository is authoritative. Check the recorded basis before acting; reconcile the board with the repository. Use verify after checking that an object remains valid. Litch does not automatically detect stale basis in this version. Personal and project instructions remain with the harness; do not copy them into these rules.',
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

const TEMPLATE_RULES: Record<ManagerTemplate, string> = {
  release:
    'Before release, list all unverified items and ask through a decision whether to complete those checks. Keep a draft of release notes as work lands.',
  investigation:
    'Track evidence and hypotheses separately in the board. Give each investigation line a concrete question and a stopping condition; record ruled-out explanations.',
  research:
    'Record sources and their limits. Give research lines distinct questions; synthesize findings and unresolved disagreements before proposing a decision.',
  blank: '',
}

/** 第 3 层初稿：手写后由界面停止自动重拼，设备保存收到的原文。 */
export function managerCustomRules(
  template: ManagerTemplate,
  dispatch: ManagerDispatchSettings,
  contact: ManagerContactSettings,
): string {
  return [
    `Default line harness: ${dispatch.harness ?? 'the manager’s harness'}. Model: ${dispatch.model ?? 'the manager’s model when the harness matches; otherwise the target harness’s default'}. Effort: ${dispatch.effort ?? 'the manager’s effort when the harness matches; otherwise the target harness’s default'}.`,
    dispatch.worktree
      ? 'Give code-changing lines their own worktrees.'
      : 'Code-changing lines share the working folder; serialize changes that overlap.',
    `At most ${dispatch.maxRunningLines} lines may run at once.`,
    dispatch.merge === 'manager'
      ? 'After acceptance, the manager integrates the line into main under project rules.'
      : 'Leave merging to the user; report which lines passed acceptance and are ready to merge.',
    'Wait for unanswered decisions; never adopt a recommendation automatically.',
    contact.desktopNotification
      ? 'Litch sends desktop notifications for new decisions.'
      : 'Desktop notifications for new decisions are disabled.',
    TEMPLATE_RULES[template],
  ]
    .filter(Boolean)
    .join('\n')
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
    'Ask whether the user wants your lines archived. Do not archive them without explicit agreement. The board becomes read-only after this finalization turn.',
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

// schema 只使用原生 Codex 会保留的关键字；跨字段引用、空白文本与状态流转由设备再次校验。
const STRING = { type: 'string' }
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
      inputSchema: {
        type: 'object',
        oneOf: [
          object(
            {
              kind: { type: 'string', const: 'decision' },
              decision: object(DECISION_FIELDS, ['title', 'background']),
            },
            ['kind', 'decision'],
          ),
          object(
            { kind: { type: 'string', const: 'item' }, item: object(ITEM_FIELDS, ['title']) },
            ['kind', 'item'],
          ),
        ],
      },
    },
    {
      type: 'function',
      name: MANAGER_TOOL.update,
      description:
        'Patch supplied fields and record why. Arrays replace whole arrays; null clears recommend. Use answer/close for decision transitions and verify for checked. Cannot write line facts.',
      inputSchema: {
        type: 'object',
        oneOf: [
          object(
            {
              kind: { type: 'string', const: 'decision' },
              id: ID,
              patch: object(DECISION_FIELDS),
              why: STRING,
            },
            ['kind', 'id', 'patch', 'why'],
          ),
          object(
            {
              kind: { type: 'string', const: 'item' },
              id: ID,
              patch: object(ITEM_FIELDS),
              why: STRING,
            },
            ['kind', 'id', 'patch', 'why'],
          ),
        ],
      },
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
      inputSchema: {
        type: 'object',
        oneOf: [
          object(
            {
              kind: { type: 'string', const: 'decision' },
              id: ID,
              status: { type: 'string', enum: ['expired', 'withdrawn'] },
              reason: STRING,
            },
            ['kind', 'id', 'status', 'reason'],
          ),
          object(
            {
              kind: { type: 'string', const: 'item' },
              id: ID,
              status: { type: 'string', enum: ['done', 'deferred'] },
              reason: STRING,
            },
            ['kind', 'id', 'status', 'reason'],
          ),
        ],
      },
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
