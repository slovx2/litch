// 无人值守的本机操作卡是会话里的待批准动作，不占用引擎请求或回合。
import { isApprovalToken } from './client-approvals.mjs'
import { validTimedApprovalHours } from './timed-approvals.mjs'

export const MACHINE_APPROVALS = 'machineApprovals'
export const MACHINE_APPROVAL_SIGNING = 'machineApprovalSigning'
export const MACHINE_APPROVAL_REVIEW_VERSION = 1
export const MACHINE_APPROVAL_DETAILS_MAX = 28_000
export const MACHINE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
export const MACHINE_APPROVAL_MAX_PER_EXECUTOR = 32
export const MACHINE_APPROVAL_MAX_TEXT = 16 * 1024
export const MACHINE_TASK_PREFIX = 'machine-approval:'

export const MACHINE_APPROVAL_METHOD = {
  list: 'litch/machineApproval/list',
  open: 'litch/machineApproval/open',
  start: 'litch/machineApproval/start',
  finish: 'litch/machineApproval/finish',
  stop: 'litch/machineApproval/stop',
  answer: 'litch/machineApproval/answerSigned',
  verify: 'litch/machineApproval/verifySigned',
} as const

export const MACHINE_APPROVAL_NOTIFICATION = {
  changed: 'litch/machineApproval/changed',
  stop: 'litch/machineApproval/stopRequested',
  changedSigned: 'litch/machineApproval/signedChanged',
} as const

export interface MachineApprovalCard {
  id: string
  threadId: string
  turnId: string | null
  action: 'exec' | 'read' | 'write' | 'list'
  /** 命令或展开的路径。手机仅浏览，完整冻结内容留在执行桌面。 */
  target: string
  cwd: string | null
  desktop: string
  expiresAt: number
  /** 仅两端声明签名能力时发。发卡 Mac 才能核对冻结对象。 */
  review?: MachineApprovalReview
}

export interface MachineApprovalReview {
  desktopId: string
  nonce: string
  version: typeof MACHINE_APPROVAL_REVIEW_VERSION
  /** 执行前会重核的本机身份与策略，只发布摘要。 */
  snapshotHash: string
  /** 含完整实质输入的预览。 */
  details: string
  payloadHash: string
}

export type MachinePhoneDecision =
  | { decision: 'once' | 'decline'; hours?: never }
  | { decision: 'timed'; hours: number }

export type MachinePhoneAnswer = MachineApprovalKey &
  Pick<MachineApprovalReview, 'desktopId' | 'nonce' | 'version' | 'payloadHash'> &
  MachinePhoneDecision & {
    expiresAt: number
    phoneId: string
    signature: string
  }

export interface MachinePhoneReceipt {
  /** 只有执行 Mac 验签并处理后为 true；设备收到了不算批准。 */
  accepted: boolean
}

/** 移动端和 Mac 对同样的可见内容求摘要。远端改预览而沿用旧摘要时，手机不会签。 */
export function machineApprovalPayload(
  card: MachineApprovalCard,
  review: Omit<MachineApprovalReview, 'payloadHash'>,
): string {
  return (
    'litch-machine-preview-v1\n' +
    JSON.stringify([
      card.id,
      card.threadId,
      card.turnId,
      card.action,
      card.target,
      card.cwd,
      card.desktop,
      card.expiresAt,
      review.desktopId,
      review.nonce,
      review.version,
      review.snapshotHash,
      review.details,
    ])
  )
}

/** 与其他手机批准使用不同域；键顺序固定，小时数为 null 时不能解释成授时。 */
export function machineApprovalSignedText(answer: Omit<MachinePhoneAnswer, 'signature'>): string {
  return (
    'litch-machine-approval-v1\n' +
    JSON.stringify({
      id: answer.id,
      threadId: answer.threadId,
      desktopId: answer.desktopId,
      nonce: answer.nonce,
      version: answer.version,
      payloadHash: answer.payloadHash,
      decision: answer.decision,
      hours: answer.decision === 'timed' ? answer.hours : null,
      expiresAt: answer.expiresAt,
      phoneId: answer.phoneId,
    })
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function isMachineApprovalReview(value: unknown): value is MachineApprovalReview {
  return (
    isRecord(value) &&
    isApprovalToken(value.desktopId) &&
    isApprovalToken(value.nonce) &&
    value.version === MACHINE_APPROVAL_REVIEW_VERSION &&
    isHash(value.snapshotHash) &&
    isHash(value.payloadHash) &&
    typeof value.details === 'string' &&
    value.details.length <= MACHINE_APPROVAL_DETAILS_MAX
  )
}

export function isMachinePhoneAnswer(value: unknown): value is MachinePhoneAnswer {
  if (
    !isRecord(value) ||
    !isMachineApprovalId(value.id) ||
    typeof value.threadId !== 'string' ||
    value.threadId.length === 0 ||
    value.threadId.length > 200 ||
    !isApprovalToken(value.desktopId) ||
    !isApprovalToken(value.nonce) ||
    value.version !== MACHINE_APPROVAL_REVIEW_VERSION ||
    !isHash(value.payloadHash) ||
    !Number.isSafeInteger(value.expiresAt) ||
    typeof value.phoneId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(value.phoneId) ||
    typeof value.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(value.signature)
  )
    return false
  return value.decision === 'timed'
    ? validTimedApprovalHours(value.hours)
    : (value.decision === 'once' || value.decision === 'decline') && !Object.hasOwn(value, 'hours')
}

export function matchesMachinePhoneAnswer(
  card: MachineApprovalCard,
  answer: MachinePhoneAnswer,
): boolean {
  const review = card.review
  return (
    !!review &&
    card.id === answer.id &&
    card.threadId === answer.threadId &&
    card.expiresAt === answer.expiresAt &&
    review.desktopId === answer.desktopId &&
    review.nonce === answer.nonce &&
    review.version === answer.version &&
    review.payloadHash === answer.payloadHash
  )
}

export interface MachineApprovalKey {
  threadId: string
  id: string
}

export type MachineApprovalOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'rejected'
  | 'expired'
  | 'lost'

export interface MachineApprovalFinish extends MachineApprovalKey {
  outcome: MachineApprovalOutcome
  /** 受限的执行结果，供设备投递给发起会话。 */
  text?: string
}

export const isMachineApprovalId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
