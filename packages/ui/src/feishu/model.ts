// 飞书界面的纯逻辑：桌面（packages/ui）和手机（apps/mobile）共用，不碰 DOM 与 React。
// 只认核心给的快照与协议类型；字由各端按这里给出的键拼。设备时间是 UTC 秒。
import {
  FEISHU_APP_ID,
  FEISHU_BACKFILL_LIMIT,
  FEISHU_BOT_NAME_MAX,
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  FEISHU_WAKERS_MAX,
  type FeishuApp,
  type FeishuBackfill,
  type FeishuCapability,
  type FeishuChat,
  type FeishuChatAccess,
  type FeishuChatAccessParams,
  type FeishuChatRecords,
  type FeishuChatUpdateParams,
  type FeishuErrorCode,
  type FeishuGapFill,
  type FeishuInboxEntry,
  type FeishuInboxMessage,
  type FeishuInboxStatus,
  type FeishuMember,
  type FeishuOutboxEntry,
  type FeishuOutboxFormat,
  type FeishuOutboxState,
  type FeishuPerson,
  type FeishuRegistration,
  type FeishuSpeechMode,
} from '../../../protocol/src/feishu.mts'
import {
  REVIEW_REASON_MAX,
  type Review,
  type ReviewSpeechPart,
  type ReviewSpeechPreview,
  type ReviewState,
} from '../../../protocol/src/reviews.mts'

export type {
  FeishuApp,
  FeishuBackfill,
  FeishuCapability,
  FeishuChat,
  FeishuChatAccess,
  FeishuChatRecords,
  FeishuGapFill,
  FeishuInboxEntry,
  FeishuInboxMessage,
  FeishuInboxStatus,
  FeishuMember,
  FeishuOutboxEntry,
  FeishuOutboxFormat,
  FeishuOutboxState,
  FeishuPerson,
  FeishuRegistration,
  FeishuSpeechMode,
  Review,
  ReviewSpeechPart,
  ReviewSpeechPreview,
  ReviewState,
}
export {
  FEISHU_BACKFILL_LIMIT,
  FEISHU_BOT_NAME_MAX,
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  FEISHU_WAKERS_MAX,
  REVIEW_REASON_MAX,
}

/**
 * 写操作为什么不能做：设备离线，或这条连接不是设备管理员（admin 为 false）。
 * admin 还没读到（null、undefined）时照常可点，由设备拒绝兜底
 */
export type WriteBlock = 'offline' | 'readOnly' | null
export function writeBlock(online: boolean, admin: boolean | null | undefined): WriteBlock {
  if (!online) return 'offline'
  return admin === false ? 'readOnly' : null
}

/** 列表上显示的连接状态：停用（enabled 为 false 或设备已停）优先于连接本身 */
export type FeishuShownState = 'connected' | 'connecting' | 'reconnecting' | 'failed' | 'stopped'
export type FeishuTone = 'ok' | 'wait' | 'err' | 'off'

export function shownState(app: Pick<FeishuApp, 'enabled' | 'connection'>): FeishuShownState {
  if (!app.enabled || app.connection.state === 'stopped') return 'stopped'
  return app.connection.state
}

export const STATE_TONE: Record<FeishuShownState, FeishuTone> = {
  connected: 'ok',
  connecting: 'wait',
  reconnecting: 'wait',
  failed: 'err',
  stopped: 'off',
}

/** 连接失败时的原因代码（只在 failed、reconnecting 时有意义） */
export function connectionReason(
  app: Pick<FeishuApp, 'enabled' | 'connection'>,
): FeishuErrorCode | null {
  const state = shownState(app)
  if (state !== 'failed' && state !== 'reconnecting') return null
  return app.connection.error?.code ?? null
}

/** 设备给的原因代码，去掉 feishu_ 前缀后就是文案键 feishu.error.<代码> 的后半 */
export const FEISHU_REASONS = [
  'app_not_found',
  'app_exists',
  'app_id_invalid',
  'credential_rejected',
  'unreachable',
  'bot_disabled',
  'revision_conflict',
  'manager_not_found',
  'manager_taken',
  'app_inactive',
  'upgrade_forbidden',
  'upgrade_failed',
  'registration_unavailable',
  'registration_not_found',
  'chat_not_found',
  'chat_accessed',
  'chat_not_accessed',
  'chat_unavailable',
  'external_unconfirmed',
  'waker_not_member',
  'members_failed',
  'sync_failed',
  'backfill_running',
  'backfill_window_invalid',
  'outbox_not_found',
  'outbox_sending',
] as const
export type FeishuReason = (typeof FEISHU_REASONS)[number]

/** 认出设备给的原因代码（ChannelError.message 是 feishu_xxx）；认不出是 null */
export function feishuReason(error: unknown): FeishuReason | null {
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message !== 'string' || !message.startsWith('feishu_')) return null
  const code = message.slice('feishu_'.length)
  return (FEISHU_REASONS as readonly string[]).includes(code) ? (code as FeishuReason) : null
}

/** 说明界面拿的是旧数据的原因：版本冲突，或群的接入状态已在别处变了。收到时先重读再提示 */
export function staleReason(reason: FeishuReason | null): boolean {
  return (
    reason === 'revision_conflict' || reason === 'chat_accessed' || reason === 'chat_not_accessed'
  )
}

export function validAppId(appId: string): boolean {
  return FEISHU_APP_ID.test(appId)
}

/** 机器人名的问题：空的、超长（按字符数，不按 UTF-16 码元）；没问题是 null */
export function botNameProblem(name: string): 'empty' | 'long' | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  return [...trimmed].length > FEISHU_BOT_NAME_MAX ? 'long' : null
}

export interface ManagerChoice {
  id: string
  name: string
}

/** 下拉里的一位经理：已分给别的应用时 takenBy 是那个应用的名字，不能选 */
export interface ManagerOption extends ManagerChoice {
  takenBy: string | null
}

/**
 * 给一个应用选经理的候选：同设备在用的经理，标出已分给别的应用的。
 * 当前分配的经理不在候选里（已结束、已删除）时补上一项，免得下拉显示空白
 */
export function managerOptions(
  apps: readonly FeishuApp[],
  managers: readonly ManagerChoice[],
  appId: string,
): ManagerOption[] {
  const takenBy = new Map<string, string>()
  for (const app of apps)
    if (app.appId !== appId && app.managerId) takenBy.set(app.managerId, app.name || app.appId)
  const options: ManagerOption[] = managers.map((one) => ({
    ...one,
    takenBy: takenBy.get(one.id) ?? null,
  }))
  const current = apps.find((app) => app.appId === appId)?.managerId
  if (current && !managers.some((one) => one.id === current))
    options.push({ id: current, name: current, takenBy: null })
  return options
}

/** 能力自检缺的项合起来：权限、事件、回调 */
export function missingGroups(capability: FeishuCapability) {
  return [
    { kind: 'scopes', items: capability.missingScopes },
    { kind: 'events', items: capability.missingEvents },
    { kind: 'callbacks', items: capability.missingCallbacks },
  ].filter((group) => group.items.length > 0) as {
    kind: 'scopes' | 'events' | 'callbacks'
    items: string[]
  }[]
}

/** 补申请已提交、在等企业管理员审核 */
export function pendingReview(capability: FeishuCapability | null): boolean {
  return capability?.publish?.state === 'pending_review'
}

/** 能点“补申请”：自检缺项，且没有在审核中的版本 */
export function canUpgrade(capability: FeishuCapability | null): boolean {
  return capability?.state === 'missing' && !pendingReview(capability)
}

/** 向导结束时显示哪一句：error 带原因的按原因说 */
export type RegistrationEnd =
  | Exclude<FeishuRegistration['state'], 'waiting'>
  | `error.${NonNullable<FeishuRegistration['error']>}`
export function registrationEnd(registration: FeishuRegistration): RegistrationEnd {
  if (registration.state === 'error' && registration.error) return `error.${registration.error}`
  return registration.state === 'waiting' ? 'error' : registration.state
}

/** 剩余秒数（设备给 UTC 秒，客户端时钟是毫秒） */
export function secondsLeft(expiresAt: number, nowMs: number): number {
  return Math.max(0, Math.floor(expiresAt - nowMs / 1000))
}

// ---------- 群 ----------

/** 列表上的接入状态：未接入、未接入但设备还留着记录（kept），或已接入的发言模式 */
export type ChatAccessState = 'none' | 'kept' | FeishuSpeechMode
export function chatAccessState(chat: Pick<FeishuChat, 'access' | 'records'>): ChatAccessState {
  if (chat.access) return chat.access.speech
  return chat.records ? 'kept' : 'none'
}

/** 群现在用不了（拉不到成员、不能新接入）的原因：已解散优先于机器人不在群里 */
export function chatUnavailable(
  chat: Pick<FeishuChat, 'status' | 'botPresent'>,
): 'dissolved' | 'botLeft' | null {
  if (chat.status === 'dissolved') return 'dissolved'
  return chat.botPresent ? null : 'botLeft'
}

/** 列表顺序：能用的在前，其中已接入的在前；同一组里保持设备给的顺序 */
export function sortChats(chats: readonly FeishuChat[]): FeishuChat[] {
  const rank = (chat: FeishuChat) => (chatUnavailable(chat) ? 2 : chat.access ? 0 : 1)
  return chats
    .map((chat, index) => ({ chat, index }))
    .sort((a, b) => rank(a.chat) - rank(b.chat) || a.index - b.index)
    .map((one) => one.chat)
}

/** 接入对话框 / 群设置里正在填的内容；两个数字按输入框里的原文存，提交时再校验 */
export interface ChatDraft {
  speech: FeishuSpeechMode | null
  /** 外部群的二次确认，只在新接入时要 */
  confirmExternal: boolean
  wakeBound: boolean
  wakers: FeishuPerson[]
  retentionDays: string
  reviewTtlHours: string
}

/** 打开时的初值：已接入的照现有设置；未接入的不预选发言模式（外部群预选审批），其余用默认值 */
export function chatDraft(chat: Pick<FeishuChat, 'access' | 'external'>): ChatDraft {
  const access = chat.access
  if (access)
    return {
      speech: access.speech,
      confirmExternal: false,
      wakeBound: access.wakeBound,
      wakers: access.wakers,
      retentionDays: String(access.retentionDays),
      reviewTtlHours: String(access.reviewTtlHours),
    }
  return {
    speech: chat.external ? 'approval' : null,
    confirmExternal: false,
    wakeBound: true,
    wakers: [],
    retentionDays: String(FEISHU_RETENTION_DAYS.default),
    reviewTtlHours: String(FEISHU_REVIEW_TTL_HOURS.default),
  }
}

/** 输入框里的整数：只认十进制数字，超出范围是 null */
export function boundedInt(
  text: string,
  range: { readonly min: number; readonly max: number },
): number | null {
  const trimmed = text.trim()
  if (!/^\d{1,6}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= range.min && value <= range.max ? value : null
}

export type DraftProblem = 'speech' | 'external' | 'retention' | 'ttl' | 'wakers'

/** 还不能提交的原因；审批过期时间只在审批发言时校验（自由发言时不显示） */
export function draftProblems(
  draft: ChatDraft,
  chat: Pick<FeishuChat, 'access' | 'external'>,
): DraftProblem[] {
  const problems: DraftProblem[] = []
  if (!draft.speech) problems.push('speech')
  if (!chat.access && chat.external && !draft.confirmExternal) problems.push('external')
  if (boundedInt(draft.retentionDays, FEISHU_RETENTION_DAYS) === null) problems.push('retention')
  if (
    draft.speech === 'approval' &&
    boundedInt(draft.reviewTtlHours, FEISHU_REVIEW_TTL_HOURS) === null
  )
    problems.push('ttl')
  if (draft.wakers.length > FEISHU_WAKERS_MAX) problems.push('wakers')
  return problems
}

/** 自由发言时审批过期时间不显示：填坏了就沿用现有值或默认值 */
function ttlOf(draft: ChatDraft, access: FeishuChatAccess | null): number {
  return (
    boundedInt(draft.reviewTtlHours, FEISHU_REVIEW_TTL_HOURS) ??
    access?.reviewTtlHours ??
    FEISHU_REVIEW_TTL_HOURS.default
  )
}

/** 新接入的参数（不含 deviceId）；还有问题时是 null */
export function accessParams(
  draft: ChatDraft,
  chat: Pick<FeishuChat, 'appId' | 'chatId' | 'revision' | 'access' | 'external'>,
): FeishuChatAccessParams | null {
  const retentionDays = boundedInt(draft.retentionDays, FEISHU_RETENTION_DAYS)
  if (!draft.speech || retentionDays === null || draftProblems(draft, chat).length) return null
  return {
    appId: chat.appId,
    chatId: chat.chatId,
    expectedRevision: chat.revision,
    speech: draft.speech,
    ...(chat.external ? { confirmExternal: true } : {}),
    wakeBound: draft.wakeBound,
    wakers: draft.wakers.map((one) => one.openId),
    retentionDays,
    reviewTtlHours: ttlOf(draft, null),
  }
}

export type ChatChanges = Omit<FeishuChatUpdateParams, 'appId' | 'chatId' | 'expectedRevision'>

/** 已接入的群改了哪些字段：只带改了的；叫醒名单按成员集合比较，不看顺序 */
export function chatChanges(draft: ChatDraft, access: FeishuChatAccess): ChatChanges {
  const changes: ChatChanges = {}
  if (draft.speech && draft.speech !== access.speech) changes.speech = draft.speech
  if (draft.wakeBound !== access.wakeBound) changes.wakeBound = draft.wakeBound
  const before = new Set(access.wakers.map((one) => one.openId))
  const after = new Set(draft.wakers.map((one) => one.openId))
  if (before.size !== after.size || [...after].some((id) => !before.has(id)))
    changes.wakers = [...after]
  const retentionDays = boundedInt(draft.retentionDays, FEISHU_RETENTION_DAYS)
  if (retentionDays !== null && retentionDays !== access.retentionDays)
    changes.retentionDays = retentionDays
  const ttl = ttlOf(draft, access)
  if (ttl !== access.reviewTtlHours) changes.reviewTtlHours = ttl
  return changes
}

/** 成员选择器的一项；listed 为 false 是名单里有、但这次读到的成员里没有的人 */
export interface MemberChoice {
  person: FeishuPerson
  listed: boolean
}

/**
 * 成员选择器的候选：已选但不在成员里的排最前（可取消勾选），其后是成员，按名字或 open_id 筛。
 * members 为 null（还没读到、读不到）时只列已选的，不标“不在群成员中”
 */
export function memberChoices(
  members: readonly FeishuMember[] | null,
  selected: readonly FeishuPerson[],
  query = '',
): MemberChoice[] {
  const listed = new Set((members ?? []).map((one) => one.openId))
  const all: MemberChoice[] = members
    ? [
        ...selected
          .filter((one) => !listed.has(one.openId))
          .map((person) => ({ person, listed: false })),
        ...members.map((person) => ({ person, listed: true })),
      ]
    : selected.map((person) => ({ person, listed: true }))
  const needle = query.trim().toLowerCase()
  if (!needle) return all
  return all.filter(
    ({ person }) =>
      person.name.toLowerCase().includes(needle) || person.openId.toLowerCase().includes(needle),
  )
}

/** 勾选或取消一位成员；已满 FEISHU_WAKERS_MAX 时不再加 */
export function toggleWaker(wakers: readonly FeishuPerson[], person: FeishuPerson): FeishuPerson[] {
  if (wakers.some((one) => one.openId === person.openId))
    return wakers.filter((one) => one.openId !== person.openId)
  if (wakers.length >= FEISHU_WAKERS_MAX) return [...wakers]
  return [...wakers, { openId: person.openId, name: person.name }]
}

// ---------- 记录与补历史 ----------

/** 已接入的群正在补历史 */
export function backfilling(chat: Pick<FeishuChat, 'access' | 'records'>): boolean {
  return chat.access !== null && chat.records?.backfill?.state === 'running'
}

/** 补历史一行用哪句：正在补 / 补完（超过上限时只留了最新的）/ 失败 */
export type BackfillLine = 'running' | 'done' | 'truncated' | 'failed'
export function backfillLine(backfill: Pick<FeishuBackfill, 'state' | 'truncated'>): BackfillLine {
  if (backfill.state === 'done') return backfill.truncated ? 'truncated' : 'done'
  return backfill.state
}

/** 手动补历史为什么不能做；按“能不能写 → 群能不能用 → 是否已接入 → 是否正在补”的次序给一个 */
export type BackfillBlock =
  | Exclude<WriteBlock, null>
  | 'dissolved'
  | 'botLeft'
  | 'notAccessed'
  | 'running'
  | null
export function backfillBlock(
  chat: Pick<FeishuChat, 'access' | 'records' | 'status' | 'botPresent'>,
  block: WriteBlock,
): BackfillBlock {
  if (block) return block
  const unavailable = chatUnavailable(chat)
  if (unavailable) return unavailable
  if (!chat.access) return 'notAccessed'
  return backfilling(chat) ? 'running' : null
}

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/

/** 本地日期 YYYY-MM-DD 那天零点（毫秒）；不是合法日期时是 null */
function localMidnight(text: string): number | null {
  const match = DAY_TEXT.exec(text.trim())
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day)
    return null
  return date.getTime()
}

/** 某个时刻（毫秒）所在的本地日期，写成 YYYY-MM-DD（日期输入框的格式） */
export function dayText(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 补历史窗口（秒，结束不含）显示成起止日期：结束日期是结束前一秒所在的那天 */
export function windowDays(start: number, end: number): { from: string; to: string } {
  return { from: dayText(start * 1000), to: dayText(Math.max(start, end - 1) * 1000) }
}

/** 手动补历史的初值：结束是今天，开始是最早一条记录（没有就是今天）往前 30 天 */
export function backfillDefaults(
  records: Pick<FeishuChatRecords, 'oldestAt'> | undefined,
  nowMs: number,
): { from: string; to: string } {
  const base = records?.oldestAt !== undefined ? records.oldestAt * 1000 : nowMs
  const before = new Date(base)
  before.setDate(before.getDate() - 30)
  return { from: dayText(before.getTime()), to: dayText(nowMs) }
}

/**
 * 两个日期换成补历史的窗口（秒）：开始取那天本地零点，结束取结束那天次日零点和现在中较早的那个。
 * 日期不合法是 format；开始不早于结束（含开始日期在今天之后）是 order
 */
export function backfillWindow(
  from: string,
  to: string,
  nowMs: number,
): { start: number; end: number } | { problem: 'format' | 'order' } {
  const startMs = localMidnight(from)
  const toMs = localMidnight(to)
  if (startMs === null || toMs === null) return { problem: 'format' }
  const next = new Date(toMs)
  next.setDate(next.getDate() + 1)
  const start = Math.floor(startMs / 1000)
  const end = Math.floor(Math.min(next.getTime(), nowMs) / 1000)
  return start < end ? { start, end } : { problem: 'order' }
}

// ---------- 经理的飞书收件箱 ----------

/** 收件箱的两段：待处理（排队中、已送进回合）与已处理 */
export const INBOX_SEGMENTS = ['open', 'done'] as const
export type InboxSegment = (typeof INBOX_SEGMENTS)[number]

export function inboxSegment(status: FeishuInboxStatus): InboxSegment {
  return status === 'processed' ? 'done' : 'open'
}

/** 一段里的条目，保持设备给的顺序（新的在前） */
export function segmentEntries(
  entries: readonly FeishuInboxEntry[],
  segment: InboxSegment,
): FeishuInboxEntry[] {
  return entries.filter((entry) => inboxSegment(entry.status) === segment)
}

/** 排队中（还没送进经理回合）的条数：经理页签上的计数 */
export function queuedCount(entries: readonly FeishuInboxEntry[]): number {
  return entries.filter((entry) => entry.status === 'queued').length
}

/**
 * 订阅给的最新一页加手动读到的更早几页：同一条以订阅的为准（状态更新），
 * 更早的只补订阅里没有的，整体按设备顺序（新的在前）
 */
export function mergeInbox(
  latest: { entries: readonly FeishuInboxEntry[]; messages: Record<string, FeishuInboxMessage> },
  older: { entries: readonly FeishuInboxEntry[]; messages: Record<string, FeishuInboxMessage> },
): { entries: FeishuInboxEntry[]; messages: Record<string, FeishuInboxMessage> } {
  const seen = new Set(latest.entries.map((entry) => entry.inboxId))
  return {
    entries: [...latest.entries, ...older.entries.filter((entry) => !seen.has(entry.inboxId))],
    messages: { ...older.messages, ...latest.messages },
  }
}

/** 行上显示的状态：排队中但叫醒额度用完时单标“限额中” */
export type InboxShownStatus = FeishuInboxStatus | 'limited'
export function inboxShownStatus(
  entry: Pick<FeishuInboxEntry, 'status' | 'note'>,
): InboxShownStatus {
  return entry.status === 'queued' && entry.note === 'rate_limited' ? 'limited' : entry.status
}

/** 发送人：有名字用名字，没有用 open_id */
export function senderLabel(entry: Pick<FeishuInboxEntry, 'senderName' | 'senderOpenId'>) {
  return entry.senderName?.trim() || entry.senderOpenId
}

/**
 * 消息正文怎么显示：有字就显示；已撤回、已删除、过了保留期、不是文字消息、消息库里没有，
 * 各给一个文案键的后半（feishu.inbox.text.<kind>）
 */
export type InboxText =
  | { kind: 'text'; text: string }
  | { kind: 'recalled' | 'deleted' | 'purged' | 'missing' }
  | { kind: 'other'; msgType: string }
export function inboxText(message: FeishuInboxMessage | undefined | null): InboxText {
  if (!message) return { kind: 'missing' }
  if (message.state === 'recalled') return { kind: 'recalled' }
  if (message.state === 'deleted') return { kind: 'deleted' }
  if (message.purged) return { kind: 'purged' }
  if (message.text?.trim()) return { kind: 'text', text: message.text }
  return { kind: 'other', msgType: message.msgType }
}

/** 群名：消息库里有就用；私聊没有群名；都没有时用 chat_id */
export function inboxChatName(
  entry: Pick<FeishuInboxEntry, 'chatKind' | 'chatId'>,
  message: Pick<FeishuInboxMessage, 'chatName'> | undefined | null,
): string | null {
  if (message?.chatName?.trim()) return message.chatName
  return entry.chatKind === 'p2p' ? null : entry.chatId
}

// ---------- 审批（litchReviews，目前只有经理在审批群里的发言） ----------

/** 设备给的审批原因代码（ChannelError.message 原样是代码）；文案键 feishu.review.error.<代码> */
export const REVIEW_REASONS = [
  'review_not_found',
  'review_revision_conflict',
  'review_not_pending',
  'review_expired',
] as const
export type ReviewReason = (typeof REVIEW_REASONS)[number]

export function reviewReason(error: unknown): ReviewReason | null {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && (REVIEW_REASONS as readonly string[]).includes(message)
    ? (message as ReviewReason)
    : null
}

/** 界面手里的审批已经旧了（别处改过、已有结果、已过期、已不在）：收到时重读 */
export function reviewStale(reason: ReviewReason | null): boolean {
  return reason !== null
}

/** 显示的状态：待批但已过了过期时间（设备还没来得及改）当作已过期，不再给批 */
export function reviewShownState(
  review: Pick<Review, 'state' | 'expiresAt'>,
  nowMs: number,
): ReviewState {
  return review.state === 'pending' && review.expiresAt * 1000 <= nowMs ? 'expired' : review.state
}

/** 列表顺序：待批的在前（快过期的在前），其余按有结果的时间新的在前；同样的保持设备给的顺序 */
export function sortReviews(reviews: readonly Review[], nowMs: number): Review[] {
  const pending = (review: Review) => reviewShownState(review, nowMs) === 'pending'
  return reviews
    .map((review, index) => ({ review, index }))
    .sort((a, b) => {
      const pa = pending(a.review)
      const pb = pending(b.review)
      if (pa !== pb) return pa ? -1 : 1
      const order = pa
        ? a.review.expiresAt - b.review.expiresAt
        : (b.review.decidedAt ?? b.review.createdAt) - (a.review.decidedAt ?? a.review.createdAt)
      return order || a.index - b.index
    })
    .map((one) => one.review)
}

/** 待批数（页签上的计数）：设备给的总数，减去列表里已过了过期时间、设备还没改的 */
export function pendingReviewCount(
  value: { reviews: readonly Review[]; pending: number } | null | undefined,
  nowMs: number,
): number {
  if (!value) return 0
  const lapsed = value.reviews.filter(
    (review) => review.state === 'pending' && reviewShownState(review, nowMs) === 'expired',
  ).length
  return Math.max(0, value.pending - lapsed)
}

/** 剩余时间：满一天按天、满一小时按小时（向下取整），不到一小时按分钟（向上取整）；已过期是 null */
export interface TimeLeft {
  unit: 'day' | 'hour' | 'minute'
  n: number
  /** 不到一小时：界面标成提醒色 */
  soon: boolean
}
export function timeLeft(expiresAt: number, nowMs: number): TimeLeft | null {
  const seconds = expiresAt - nowMs / 1000
  if (seconds <= 0) return null
  if (seconds >= 86_400) return { unit: 'day', n: Math.floor(seconds / 86_400), soon: false }
  if (seconds >= 3600) return { unit: 'hour', n: Math.floor(seconds / 3600), soon: false }
  return { unit: 'minute', n: Math.max(1, Math.ceil(seconds / 60)), soon: true }
}

/** 列表上的内容开头：第一段有字的取第一行非空的字，否则取第一个图片或文件的名字 */
export function speechHead(parts: readonly ReviewSpeechPart[]): string {
  for (const part of parts) {
    const line = part.text
      ?.split('\n')
      .map((one) => one.trim())
      .find(Boolean)
    if (line) return line
  }
  return parts.find((part) => part.name)?.name ?? ''
}

/** 格式小标记：各段的格式去重，按出现的先后 */
export function speechFormats(parts: readonly ReviewSpeechPart[]): ReviewSpeechPart['format'][] {
  return [...new Set(parts.map((part) => part.format))]
}

/** 理由的问题：超过 REVIEW_REASON_MAX 个字（按字符数）；没问题是 null */
export function reasonProblem(reason: string): 'long' | null {
  return [...reason.trim()].length > REVIEW_REASON_MAX ? 'long' : null
}

/** 批准或拒绝的参数（不含 deviceId）：带上界面手里的 revision；理由去掉首尾空白，空的不带 */
export function decideParams(
  review: Pick<Review, 'reviewId' | 'revision'>,
  decision: 'approve' | 'reject',
  reason: string,
): { reviewId: string; decision: 'approve' | 'reject'; expectedRevision: number; reason?: string } {
  const trimmed = reason.trim()
  return {
    reviewId: review.reviewId,
    decision,
    expectedRevision: review.revision,
    ...(trimmed ? { reason: trimmed } : {}),
  }
}

// ---------- 发件队列 ----------

export const OUTBOX_TONE: Record<FeishuOutboxState, FeishuTone> = {
  awaiting_approval: 'wait',
  queued: 'wait',
  sending: 'wait',
  sent: 'ok',
  failed: 'err',
  rejected: 'off',
  canceled: 'off',
  unknown: 'err',
}

/** 能撤下的：还没发出去的（待审批、排队）和结果不明的；发送中、已有结果的不能撤 */
export function canCancelOutbox(state: FeishuOutboxState): boolean {
  return state === 'awaiting_approval' || state === 'queued' || state === 'unknown'
}

/** 发件行的出错原因代码；文案键 feishu.outbox.error.<代码>，认不出的用 other */
export const OUTBOX_ERRORS = [
  'review_rejected',
  'review_expired',
  'review_canceled',
  'canceled_by_manager',
  'canceled_by_admin',
  'payload_changed',
  'chat_unavailable',
  'user_unbound',
  'app_inactive',
  'review_mismatch',
  'unknown_timeout',
  'permission',
  'not_found',
  'platform',
  'invalid',
  'credential_rejected',
] as const
export type OutboxError = (typeof OUTBOX_ERRORS)[number] | 'other'

/** 行上要写的原因；没有原因、或原因和状态说的是一回事（被拒且是审批被拒）时是 null */
export function outboxReason(
  entry: Pick<FeishuOutboxEntry, 'state' | 'error'>,
): OutboxError | null {
  if (!entry.error) return null
  if (entry.state === 'rejected' && entry.error === 'review_rejected') return null
  return (OUTBOX_ERRORS as readonly string[]).includes(entry.error)
    ? (entry.error as OutboxError)
    : 'other'
}

/** 订阅给的最新一页加手动读到的更早几页：同一条以订阅的为准，更早的只补没有的 */
export function mergeOutbox(
  latest: readonly FeishuOutboxEntry[],
  older: readonly FeishuOutboxEntry[],
): FeishuOutboxEntry[] {
  const seen = new Set(latest.map((entry) => entry.operationId))
  return [...latest, ...older.filter((entry) => !seen.has(entry.operationId))]
}
