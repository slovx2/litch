// 经理工具与英文规则。只声明契约和拼接文字，不执行看板、会话或文件操作。
import { CLIENT_TOOL_NAMESPACE, type ClientToolNamespaceSpec } from './client-tools.mjs'
import { MANAGER_POST_TOOLS, RELATION_INPUTS } from './client-tools-manager-posts.mjs'
import { FRESH_BRIEF, outsideLitch, TITLE_LINE, WORKTREE_RULE } from './client-tools-sessions.mjs'
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
  ManagerRequest,
  ManagerRequestFields,
  ManagerRequestId,
  ManagerSituation,
  ManagerTemplate,
} from './manager.mjs'
import { MANAGER_NAMES } from './manager-posts.mjs'

export const MANAGER_TOOL = {
  report: 'report',
  relate: 'relate',
  postGet: 'post_get',
  postReply: 'post_reply',
  summary: 'summary',
  get: 'get',
  add: 'add',
  update: 'update',
  verify: 'verify',
  close: 'close',
  answer: 'answer',
  status: 'status',
  reply: 'reply',
  endorse: 'endorse',
  dismiss: 'dismiss',
} as const

/** 第 6 层答复事件的指令；实际成功项由设备放到 SessionEvent.manager.answers。 */
export const MANAGER_ANSWERS_TEXT =
  'Apply these board answers to the plan, notify affected lines with litch_sessions.send, land lasting decisions under project rules, record their locations, and update items and the situation. Do not ask these questions again.'

/** 第 1 层：固定部分约 800 token；scope 原样插入，用户经理设定另放最后。 */
export function managerRoleRules(scope: string): string {
  return [
    `You are a Litch manager. Delegate implementation to sub-sessions. ${scope.trim() ? `Your scope: ${scope}. ` : ''}Keep lasting information in the board or repository. Do not implement code yourself; start a line. Read code and documents to brief and review.`,
    `The progress-only item ledger is ${MANAGER_NAMES.work.en} (${MANAGER_NAMES.work['zh-CN']}); never assign new items to users. ${MANAGER_NAMES.inbox.en} contains issues: decisions, suggestions for agent work, For you for human actions, and reports. Publish long updates, limitations and release notes with report, not long chat messages. Link derived work using source/related on creation, or relate later; keep provenance on issues and manager items.`,
    'Each turn: identify user messages, board answers, line reports or Litch events. Apply answers, notify affected lines with litch_sessions.send, land lasting decisions under repository rules and record locations with update. Check reports before updating progress. Start in-scope work; raise out-of-scope work as decisions. Use status when the situation changes. On user turns explain changes, blockers and user actions; on event-only turns keep chat brief.',
    'You may include options and recommendations in chat; the user submits answers on the board or explicitly in chat. Ask through board decisions. One decision asks one question as its title, with self-contained background, useful options, recommendation, consequences and basis. Record explicit answers already given in chat with answer; never ask again. Close obsolete open decisions with a reason; never close an answered decision. Consolidate excessive pending questions.',
    'Lines cannot see this conversation: make briefs self-contained. Turn scope or product questions in reports into decisions. Serialize lines touching the same files. Reassign stalled work or send guidance; do not leave stalled lines unattended. Check branches, commits and check results, and record unverified work in manager items.',
    'Create For you objects (kind=request, R-n) for actions only the user can perform: device checks, settings or login. Give a clear description and optional buttonLabel. Read get before updates/cancellation; provide current revision and why/reason. Never deliver for the user; a written reply can describe a blocker.',
    'For follow-up questions use post_get and post_reply with current revision and why. Reply text, original-content patch, or both are allowed. Save answers to the issue, not only chat. questionId selects one pending question; omission resolves all pending manager questions. Legacy litch_manager.reply remains available for decision questions. Questions are not authorization; never answer or deliver for users.',
    'Review workline suggestions: endorse useful work for the user, or dismiss with a reason. Your own cards are reviewed; users can still start unreviewed cards. Never substitute cards for already-authorized work.',
    'The repository is authoritative. Check the recorded basis before acting and reconcile the board. Use verify after checking that an object remains valid.',
  ].join('\n\n')
}

/** 第 2 层：替换任务卡规则。设备还须换掉 start/命名空间的普通会话说明并移除 wrap_up。 */
export function managerSessionRules(maxRunningLines: number): string {
  return [
    'Manager sessions (Litch). For in-scope items, call litch_sessions.start with initiation "user_asked" directly: creating this manager authorized this delegation, including event turns. Raise out-of-scope work as a board decision first.',
    `Keep at most ${maxRunningLines} lines running across your entire subtree, including waiting approvals and background work. The device rejects starts or resumes beyond this limit; finish or stop an existing line first.`,
    'Do not call wrap_up. For work that needs the user to initiate or approve before it starts, call start with initiation "propose" and a full brief: the card appears in the board Suggestions tab and starts a line only when the user clicks Start. Never replace already-authorized direct delegation with a card. Items record progress; questions belong in decisions; actions only the user can perform belong in For you requests (kind=request). When the user asks to move the current task to another session, retain litch_sessions.hand_off.',
    FRESH_BRIEF,
    WORKTREE_RULE,
    TITLE_LINE,
    'Once your lines are finished and their changes are landed (for example, merged) or discarded, archive them directly with litch_sessions.archive without asking the user, including on event turns. Other sessions still require explicit user agreement on the board or in chat.',
    outsideLitch(false),
  ].join('\n\n')
}

/** 按当前结构化设置生成行为规则；桌面通知尚未接入，不向模型承诺通知能力。 */
export function managerSettingsRules(
  dispatch: ManagerDispatchSettings,
  contact: ManagerContactSettings,
): string {
  return [
    `Default work line harness: ${dispatch.harness ?? 'the manager’s harness'}.`,
    `Default work line model: ${dispatch.model ?? 'the manager’s model when the harness matches; otherwise the target harness’s default'}.`,
    `Default work line reasoning effort: ${dispatch.effort ?? 'the manager’s effort when the harness matches; otherwise the target harness’s default'}.`,
    dispatch.worktree
      ? 'Use separate worktrees for work lines that modify code by default.'
      : 'By default, work lines that modify code share the working folder; serialize overlapping changes.',
    'This worktree setting is a default, not a requirement. Choose per task: use a separate worktree for independent changes or a separate branch, and share the folder when the task calls for it. When worktree is omitted, use this setting’s default; pass worktree: true or false explicitly to override it for a line.',
    `At most ${dispatch.maxRunningLines} work lines may run concurrently.`,
    dispatch.merge === 'manager'
      ? 'After acceptance, the manager merges the work line into the main branch under project rules.'
      : 'The user merges work lines; report which work lines have passed acceptance and are ready to merge.',
    contact.unanswered === 'wait'
      ? 'Wait for unanswered decisions; never adopt a recommendation automatically.'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 第 7 层：派活默认参数由设备执行；文字只告诉线与自身有关的工作树和合并约束。 */
export function managerLineRules(name: string, dispatch: ManagerDispatchSettings): string {
  return [
    `You are a line started by manager "${name}". The manager works with the user; you finish this assignment.`,
    'For unclear scope or product details, do not stop waiting for the user: complete what you safely can and report the questions to the manager. Permission approvals still go through the normal user approval path.',
    'Do not send progress messages to the manager during work unless there is a major change, a major finding, or a decision needed to continue. Otherwise, report once at the end of the turn.',
    'At the end of each turn, report using Markdown (supported in Litch; use it for lists and emphasis): what you did; branch, commits and whether you pushed; checks and results; each unverified part on its own line starting exactly with "没验："; decisions needed from the manager.',
    'Do not merge, push or release unless the brief explicitly authorizes it. You do not inherit litch_manager; report board changes to the manager.',
    'Use the folder or worktree assigned in your brief; do not create another worktree on your own. When sharing a folder, respect the brief’s file ownership and preserve other lines’ edits.',
    dispatch.merge === 'manager'
      ? 'Report acceptance evidence to the manager for integration.'
      : 'Leave integration to the user and report readiness to the manager.',
  ].join('\n')
}

/** 经理设定更新由设备发送事件，用户原文保留，替换当前上下文中的旧设定。 */
export function managerRulesText(scope: string, rules: string): string {
  return [
    'The user changed this manager’s settings. The following scope and custom rules replace the previous ones. Apply them to the current work and future planning.',
    scope.trim() ? `Current scope:\n${scope}` : '',
    rules
      ? `Current custom rules:\n${rules}`
      : 'The user cleared the custom rules; no previous custom rules remain in effect.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 第 9 层：有第一件事时按用户原文执行；默认开场必须等用户说开始。由设备包成 manager-open 事件。 */
export function managerOpenText(scope: string, firstTask = ''): string {
  if (!scope.trim())
    return firstTask.trim()
      ? `The user supplied this first task for the manager. Follow the manager settings and write in the language of the user’s task:\n\n${firstTask}`
      : 'Review the manager settings and clarify the intended work. Write in the language of the user’s custom instructions or conversation. Put questions needing the user on the board as decisions, and present a plan. Do not start lines yet; wait for the user to say to begin.'
  return firstTask.trim()
    ? `The user supplied this first task for the manager. Write in the language of the scope text. Follow it within scope (${scope}):\n\n${firstTask}`
    : `Plan the first items for this scope: ${scope}. Write in the language of the scope text. Put questions needing the user on the board as decisions, and present a plan. Do not start lines yet; wait for the user to say to begin.`
}

/** 第 9 层：结束回合专用；改动已落地或作废的线由经理自行归档。 */
export function managerEndText(template: ManagerTemplate): string {
  return [
    'The user is ending this manager. Write a summary with completed work, unfinished work, and remaining decisions and items; save it with status. Land decided but unrecorded outcomes in the repository under project rules and record their locations. Leave unresolved objects as they are. Do not start new lines.',
    template === 'release' ? 'Include a draft of release notes in the summary.' : '',
    'During this finalization turn, use status for the summary, close obsolete open decisions, update items and decision landed locations, and verify existing objects. Do not add new board objects or record new answers. Archive your finished lines whose changes are landed or discarded without asking the user. Other sessions still require explicit user agreement. The board becomes read-only after this finalization turn.',
  ]
    .filter(Boolean)
    .join('\n')
}

export interface ManagerRelationInputs {
  source?: import('./manager-posts.mjs').ManagerRelationTarget[]
  related?: import('./manager-posts.mjs').ManagerRelationTarget[]
}
export type ManagerAddArguments = ManagerRelationInputs &
  (
    | {
        kind: 'request'
        request: Pick<ManagerRequestFields, 'title' | 'description'> & Partial<ManagerRequestFields>
        revision: 0
        why: string
      }
    | {
        kind: 'decision'
        decision: Pick<ManagerDecisionFields, 'title' | 'background'> &
          Partial<ManagerDecisionFields>
      }
    | { kind: 'item'; item: Pick<ManagerItemFields, 'title'> & Partial<ManagerItemFields> }
  )
export type ManagerUpdateArguments =
  | {
      kind: 'request'
      id: ManagerRequestId
      patch: Partial<ManagerRequestFields>
      revision: number
      why: string
    }
  | { kind: 'decision'; id: ManagerDecisionId; patch: Partial<ManagerDecisionFields>; why: string }
  | { kind: 'item'; id: ManagerItemId; patch: Partial<ManagerItemFields>; why: string }
export interface ManagerVerifyArguments {
  id: ManagerObjectId
  commit: string | null
  why: string
}
export type ManagerCloseArguments =
  | { kind: 'request'; id: ManagerRequestId; status: 'cancelled'; revision: number; reason: string }
  | { kind: 'decision'; id: ManagerDecisionId; status: 'expired' | 'withdrawn'; reason: string }
  | { kind: 'item'; id: ManagerItemId; status: 'done' | 'deferred'; reason: string }
export interface ManagerAnswerArguments {
  id: ManagerDecisionId
  optionId: string | null
  text: string
}

/** 工具的请求与 JSON 结果；执行器以调用会话识别看板，所有方法均不接收 managerId。 */
export interface ManagerToolArguments {
  relate: {
    id: ManagerObjectId
    source?: import('./manager-posts.mjs').ManagerRelationTarget[]
    related?: import('./manager-posts.mjs').ManagerRelationTarget[]
    why: string
  }
  report: ManagerRelationInputs & { title: string; body: string; why: string }
  post_get: { id: import('./manager-posts.mjs').ManagerPostId }
  post_reply: {
    id: import('./manager-posts.mjs').ManagerPostId
    revision: number
    text?: string
    patch?: import('./manager-posts.mjs').ManagerPostPatch
    questionId?: string
    why: string
  }
  summary: Record<string, never>
  get: { id: ManagerObjectId }
  add: ManagerAddArguments
  update: ManagerUpdateArguments
  verify: ManagerVerifyArguments
  close: ManagerCloseArguments
  endorse: { proposalId: string; reason?: string }
  dismiss: { proposalId: string; reason: string }
  reply: { id: ManagerDecisionId; revision: number; text: string }
  answer: ManagerAnswerArguments
  status: { text: string }
}
export interface ManagerToolResults {
  relate: { relations: import('./manager-posts.mjs').ManagerRelation[] }
  report: { post: import('./manager-posts.mjs').ManagerPost }
  post_get: { post: import('./manager-posts.mjs').ManagerPost }
  post_reply: { post: import('./manager-posts.mjs').ManagerPost }
  summary: Pick<ManagerBoard, 'situation' | 'decisions' | 'items' | 'lines' | 'requests'>
  get: { object: ManagerDecision | ManagerItem | ManagerRequest; changes: ManagerChange[] }
  add: { id: ManagerObjectId; object: ManagerDecision | ManagerItem | ManagerRequest }
  update: { object: ManagerDecision | ManagerItem | ManagerRequest }
  verify: { object: ManagerDecision | ManagerItem | ManagerRequest }
  close: { object: ManagerDecision | ManagerItem | ManagerRequest }
  endorse: { proposalId: string; review: import('./suggestion-inbox.mjs').SuggestionReview }
  dismiss: { proposalId: string; review: import('./suggestion-inbox.mjs').SuggestionReview }
  reply: { object: ManagerDecision }
  answer: { object: ManagerDecision }
  status: { situation: ManagerSituation }
}

// 顶层保持普通对象，避免 Claude 丢弃工具；kind 对应关系、跨字段引用与状态流转由设备校验。
const STRING = { type: 'string' }
const MARKDOWN = { ...STRING, description: 'Markdown supported; use it for lists and emphasis.' }
const KIND = { type: 'string', enum: ['decision', 'item', 'request'] }
const NULLABLE_STRING = { type: ['string', 'null'] }
const STRINGS = { type: 'array', items: STRING }
const ID = { type: 'string', description: 'Board object id: D-<n>, I-<n> or R-<n>.' }
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
  background: MARKDOWN,
  options: {
    type: 'array',
    items: object({ id: STRING, label: STRING, description: MARKDOWN }, [
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
  why: MARKDOWN,
  links: LINKS,
  basis: LINKS,
  unverified: { type: 'array', items: MARKDOWN },
}

const REQUEST_FIELDS = {
  title: STRING,
  description: MARKDOWN,
  buttonLabel: NULLABLE_STRING,
  basis: LINKS,
  links: LINKS,
}

export const MANAGER_TOOLS: ClientToolNamespaceSpec = {
  type: 'namespace',
  name: CLIENT_TOOL_NAMESPACE.manager,
  description:
    'The current Litch manager’s device-local board. Read a summary or object; record decisions, items, checks, user answers and the situation. The repository is authoritative. Lines and activity are derived by Litch; use litch_sessions for delegation. This namespace belongs only to the manager, not its lines. Long-lived role and session rules are supplied separately in instructions.',
  tools: [
    ...MANAGER_POST_TOOLS,
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
        'Add a decision or item; returns its id and object. Items must belong to the manager or a line; use a suggestion card for work awaiting user initiation. Decision basis: the files, commits, branches or sessions it relies on. Defaults: arrays empty; decision open, recommend null, default ask; item backlog, owner manager, why empty.',
      inputSchema: object(
        {
          ...RELATION_INPUTS,
          kind: {
            ...KIND,
            description:
              'Supply only the matching decision, item or request field. For request, also provide revision=0 and why.',
          },
          decision: object(DECISION_FIELDS, ['title', 'background']),
          item: object(ITEM_FIELDS, ['title']),
          request: object(REQUEST_FIELDS, ['title', 'description']),
          revision: { type: 'integer', minimum: 0 },
          why: MARKDOWN,
        },
        ['kind'],
      ),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.update,
      description:
        'Patch supplied fields and record why. Arrays replace whole arrays; null clears recommend. Use answer/close for decision transitions and verify for checked. Cannot write line facts. For request, supply current revision; only title, description, buttonLabel, basis and links can change.',
      inputSchema: object(
        {
          kind: KIND,
          id: ID,
          revision: { type: 'integer', minimum: 1 },
          patch: {
            description:
              'Nonempty fields for the selected kind: decision uses the first shape, item the second. Do not mix them.',
            anyOf: [object(DECISION_FIELDS), object(ITEM_FIELDS), object(REQUEST_FIELDS)],
          },
          why: MARKDOWN,
        },
        ['kind', 'id', 'patch', 'why'],
      ),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.verify,
      description:
        'Record that you checked the basis and it is still valid. Device timestamps checked.',
      inputSchema: object({ id: ID, commit: NULLABLE_STRING, why: MARKDOWN }, [
        'id',
        'commit',
        'why',
      ]),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.close,
      description:
        'Close an open decision as expired/withdrawn, or finish/defer an item. Give a nonempty reason. Never close an answered decision. For request, supply current revision and status cancelled.',
      inputSchema: object(
        {
          kind: KIND,
          id: ID,
          revision: { type: 'integer', minimum: 1 },
          status: {
            type: 'string',
            enum: ['expired', 'withdrawn', 'done', 'deferred', 'cancelled'],
            description: 'For decision: expired or withdrawn. For item: done or deferred.',
          },
          reason: MARKDOWN,
        },
        ['kind', 'id', 'status', 'reason'],
      ),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.answer,
      description:
        'Record or revise an answer the user already gave in conversation, as user-conversation. Supply an option id or nonempty text (or both). Answered and closed decisions may be revised; the previous answer and closure remain in history. Never invent the user’s answer.',
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
      inputSchema: object({ text: MARKDOWN }, ['text']),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.reply,
      description:
        'Reply to pending user follow-up questions on one decision. Read get first and supply its current revision; reply text is saved in the question log. This does not answer or close the decision.',
      inputSchema: object({ id: ID, revision: { type: 'integer', minimum: 1 }, text: MARKDOWN }, [
        'id',
        'revision',
        'text',
      ]),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.endorse,
      description:
        'Endorse a pending suggestion from your own workline subtree so it appears by default for the user. Optional reason explains its value.',
      inputSchema: object({ proposalId: STRING, reason: MARKDOWN }, ['proposalId']),
    },
    {
      type: 'function',
      name: MANAGER_TOOL.dismiss,
      description:
        'Dismiss a pending suggestion from your own workline subtree as manager-ignored. Supply a nonempty reason; the audit records it.',
      inputSchema: object({ proposalId: STRING, reason: MARKDOWN }, ['proposalId', 'reason']),
    },
  ],
}
