// 界面上的限时授权：一张待处理卡片属于哪一类（能不能出“N 小时内允许所有动作”），剩多久的说法。
// 桌面与手机共用。是否真的放行以会话所在设备为准（原生审批设备代答，客户端工具核心按名单判定）。
import type { TimedApprovalCategory } from '../../protocol/src/timed-approvals.mjs'
import { clientAskCategory } from './device/tool-calls.mjs'
import type { RequestView } from './model.mjs'

export {
  TIMED_APPROVAL_MAX_HOURS,
  TIMED_APPROVAL_MIN_HOURS,
  TIMED_APPROVAL_PRESETS,
  type TimedApproval,
  type TimedApprovalCategory,
  validTimedApprovalHours,
} from '../../protocol/src/timed-approvals.mjs'
export type { TimedApprovalsView } from './device/timed-approvals.mjs'

/**
 * 这张卡片能按哪一类限时授权放行；不能的返回 null：
 * 提问、表单、MCP 工具、Computer Use 访问 Litch 自身、登录交接、开启操作本机的确认、
 * 命令里提到禁止位置的操作本机，以及没有“允许”这一项的审批
 */
export function timedCategoryOf(request: RequestView): TimedApprovalCategory | null {
  if (request.kind === 'approval') {
    if (request.subject === 'tool') return null
    return request.options.some((option) => option.role === 'accept') ? request.subject : null
  }
  if (request.kind !== 'clientAsk') return null
  if (!request.options.some((option) => option.role === 'accept')) return null
  const { ask } = request
  if (ask.kind === 'machine') return ask.enable || ask.flagged.length > 0 ? null : 'machine'
  return clientAskCategory(ask)
}

/** 剩余时长，按整分钟四舍五入：给界面拼“还剩 X 小时 Y 分”（不足一分钟由界面写成 1 分） */
export function timedRemaining(expiresAt: number, now: number): { hours: number; minutes: number } {
  const minutes = Math.max(0, Math.round((expiresAt - now) / 60_000))
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 }
}
