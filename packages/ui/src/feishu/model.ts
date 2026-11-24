// 飞书界面的纯逻辑：桌面（packages/ui）和手机（apps/mobile）共用，不碰 DOM 与 React。
// 只认核心给的快照与协议类型；字由各端按这里给出的键拼。设备时间是 UTC 秒。
import {
  FEISHU_APP_ID,
  FEISHU_BOT_NAME_MAX,
  FEISHU_RETENTION_DAYS,
  FEISHU_REVIEW_TTL_HOURS,
  FEISHU_WAKERS_MAX,
  type FeishuApp,
  type FeishuCapability,
  type FeishuChat,
  type FeishuChatAccess,
  type FeishuChatAccessParams,
  type FeishuChatUpdateParams,
  type FeishuErrorCode,
  type FeishuMember,
  type FeishuPerson,
  type FeishuRegistration,
  type FeishuSpeechMode,
} from '../../../protocol/src/feishu.mts'

export type {
  FeishuApp,
  FeishuCapability,
  FeishuChat,
  FeishuChatAccess,
  FeishuMember,
  FeishuPerson,
  FeishuRegistration,
  FeishuSpeechMode,
}
export { FEISHU_BOT_NAME_MAX, FEISHU_RETENTION_DAYS, FEISHU_REVIEW_TTL_HOURS, FEISHU_WAKERS_MAX }

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

/** 列表上的接入状态：未接入，或已接入的发言模式 */
export type ChatAccessState = 'none' | FeishuSpeechMode
export function chatAccessState(chat: Pick<FeishuChat, 'access'>): ChatAccessState {
  return chat.access?.speech ?? 'none'
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
