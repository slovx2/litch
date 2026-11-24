// 通用审批（litchReviews 扩展）：Agent 要做、但得先由人批的动作。目前只有一种：经理在要审批的飞书群里发言。
// 和手机批准（clientApprovals）、限时授权都不是一回事：审批批的是设备冻结好的那份内容（按哈希核对），批完由设备照原样执行。
// 时间用 UTC epoch 秒。

export const REVIEWS_EXTENSION = 'litchReviews'

export const REVIEWS_METHOD = {
  list: 'litch/reviews/list',
  get: 'litch/reviews/get',
  decide: 'litch/reviews/decide',
} as const

export const REVIEWS_NOTIFICATION = {
  changed: 'litch/reviews/changed',
} as const

/** 只读方法；decide 只给设备管理员连接 */
export const REVIEWS_PUBLIC_READS: ReadonlySet<string> = new Set([
  REVIEWS_METHOD.list,
  REVIEWS_METHOD.get,
])

export const REVIEW_ID = /^A-[1-9][0-9]{0,15}$/
export const REVIEW_REASON_MAX = 500

export type ReviewState = 'pending' | 'approved' | 'rejected' | 'canceled' | 'expired'
export type ReviewKind = 'speech'

/** 发言的一条（长消息会分成几条发） */
export interface ReviewSpeechPart {
  format: 'text' | 'post' | 'card' | 'image' | 'file'
  /** 文字、富文本、卡片：发出去的正文（Markdown；@ 写成 @名字） */
  text?: string
  /** 图片、文件：文件名和字节数 */
  name?: string
  size?: number
}

/** 发言审批的预览：发到哪、以谁的身份、@ 了谁、内容 */
export interface ReviewSpeechPreview {
  kind: 'speech'
  provider: 'feishu'
  appId: string
  appName: string
  target: { kind: 'chat' | 'user'; id: string; name: string }
  replyTo?: { messageId: string; text?: string }
  actingAs: { type: 'bot' } | { type: 'user'; openId: string; name: string }
  mentions: { openId: string; name: string }[]
  parts: ReviewSpeechPart[]
  /** 经 lark-cli 发的：原始请求的方法、打码后的路径、动作 */
  cli?: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; action: string }
}

export interface Review {
  /** A-<n> */
  reviewId: string
  revision: number
  kind: ReviewKind
  provider: string
  /** 范围，飞书是 appId/chatId（私聊是 appId/openId） */
  scope: string
  /** 审批的对象，发言是发件队列的操作 ID */
  subjectRef: string
  requestedBy: { managerId: string; threadId?: string; turnId?: string }
  preview: ReviewSpeechPreview
  /** 冻结内容的 SHA-256 */
  payloadHash: string
  state: ReviewState
  /** litch：在 Litch 里批的（who 是连接类型）；feishu：在飞书卡片上批的（who 是 open_id） */
  decidedBy?: { via: 'litch' | 'feishu'; who?: string }
  decidedAt?: number
  reason?: string
  createdAt: number
  expiresAt: number
}

type Request<P, R> = { params: P; result: R }

export interface ReviewsRequests {
  /** 新的在前；before 是上一页最后一条的 reviewId */
  [REVIEWS_METHOD.list]: Request<
    { states?: ReviewState[]; managerId?: string; before?: string; limit?: number },
    { reviews: Review[]; next?: string }
  >
  [REVIEWS_METHOD.get]: Request<{ reviewId: string }, { review: Review }>
  [REVIEWS_METHOD.decide]: Request<
    {
      reviewId: string
      decision: 'approve' | 'reject'
      reason?: string
      expectedRevision: number
    },
    { review: Review }
  >
}

export interface ReviewsNotifications {
  [REVIEWS_NOTIFICATION.changed]: { reviewId: string; revision: number; managerId: string }
}

export type ReviewsMethod = keyof ReviewsRequests

// —— 入站参数的形状校验，设备与核心共用 ——

type Check = (value: unknown) => boolean
const STATES = new Set(['pending', 'approved', 'rejected', 'canceled', 'expired'])
const reviewId: Check = (value) => typeof value === 'string' && REVIEW_ID.test(value)
const managerId: Check = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const int =
  (min: number, max: number): Check =>
  (value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const states: Check = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.length <= STATES.size &&
  new Set(value).size === value.length &&
  value.every((item) => STATES.has(item))
const reason: Check = (value) => typeof value === 'string' && [...value].length <= REVIEW_REASON_MAX

function obj(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const fields = value as Record<string, unknown>
    return (
      Object.entries(required).every(
        ([key, check]) => Object.hasOwn(fields, key) && check(fields[key]),
      ) &&
      Object.entries(fields).every(
        ([key, field]) =>
          Object.hasOwn(required, key) || (Object.hasOwn(optional, key) && optional[key]?.(field)),
      )
    )
  }
}

const checks = {
  [REVIEWS_METHOD.list]: obj({}, { states, managerId, before: reviewId, limit: int(1, 200) }),
  [REVIEWS_METHOD.get]: obj({ reviewId }),
  [REVIEWS_METHOD.decide]: obj(
    {
      reviewId,
      decision: (value) => value === 'approve' || value === 'reject',
      expectedRevision: int(1, Number.MAX_SAFE_INTEGER),
    },
    { reason },
  ),
} satisfies { [M in ReviewsMethod]: Check }

export function isReviewsMethod(method: string): method is ReviewsMethod {
  return Object.hasOwn(checks, method)
}

export function isReviewsMethodParams<M extends ReviewsMethod>(
  method: M,
  params: unknown,
): params is ReviewsRequests[M]['params'] {
  return checks[method](params ?? {})
}
