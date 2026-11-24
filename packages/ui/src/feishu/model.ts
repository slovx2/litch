// 飞书界面的纯逻辑：桌面（packages/ui）和手机（apps/mobile）共用，不碰 DOM 与 React。
// 只认核心给的快照与协议类型；字由各端按这里给出的键拼。设备时间是 UTC 秒。
import {
  FEISHU_APP_ID,
  FEISHU_BOT_NAME_MAX,
  type FeishuApp,
  type FeishuCapability,
  type FeishuErrorCode,
  type FeishuRegistration,
} from '../../../protocol/src/feishu.mts'

export type { FeishuApp, FeishuCapability, FeishuRegistration }
export { FEISHU_BOT_NAME_MAX }

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
] as const
export type FeishuReason = (typeof FEISHU_REASONS)[number]

/** 认出设备给的原因代码（ChannelError.message 是 feishu_xxx）；认不出是 null */
export function feishuReason(error: unknown): FeishuReason | null {
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message !== 'string' || !message.startsWith('feishu_')) return null
  const code = message.slice('feishu_'.length)
  return (FEISHU_REASONS as readonly string[]).includes(code) ? (code as FeishuReason) : null
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
