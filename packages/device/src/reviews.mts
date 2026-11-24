// 通用审批（litchReviews）：Agent 要做、但得先由人批的动作，存在 manager.sqlite 的 reviews 表。
// 审批只管状态：谁发起、给人看的预览、冻结内容的哈希、待批 → 批准 / 拒绝 / 撤下 / 过期。
// 批了以后做什么由各来源的执行方决定（register），执行方在同一个事务里跟着改自己的状态。
import {
  isReviewsMethod,
  isReviewsMethodParams,
  REVIEWS_METHOD as M,
  REVIEWS_EXTENSION,
  REVIEWS_NOTIFICATION,
  REVIEWS_PUBLIC_READS,
  type Review,
  type ReviewState,
  type ReviewsMethod,
  type ReviewsRequests,
} from '../../protocol/src/reviews.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ManagerStore } from './manager-store.mjs'
import { DeviceError } from './wire.mjs'

export const REVIEWS_MIGRATION = `
CREATE TABLE reviews(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, manager_id TEXT NOT NULL,
  provider TEXT NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE INDEX reviews_state ON reviews(state, expires_at);
CREATE INDEX reviews_manager ON reviews(manager_id, seq);
`

/** 原因代码就是错误消息，客户端据此选文案 */
export class ReviewInputError extends ProtocolError {
  constructor(reason: string) {
    super(-32602, reason)
  }
}
const fail = (reason: string): never => {
  throw new ReviewInputError(reason)
}

export interface ReviewExecutor {
  /** 审批有了结果（批准、拒绝、撤下、过期），在写结果的同一个事务里调用 */
  settled(review: Review): void
  /** 事务提交以后（比如开始发送） */
  after?(review: Review): void
  /** 每次通知客户端时（新建、撤下、有结果），比如同步飞书里的审批卡片 */
  changed?(review: Review): void
}

export type NewReview = Omit<Review, 'reviewId' | 'revision' | 'state' | 'createdAt'>

export interface DeviceReviewsOptions {
  managers: ManagerStore
  /** 秒 */
  now: () => number
  announce: (method: string, params: unknown) => void
  log: (message: string) => void
}

const LIST_DEFAULT = 50

export class DeviceReviews {
  private readonly options: DeviceReviewsOptions
  private readonly executors = new Map<string, ReviewExecutor>()

  constructor(options: DeviceReviewsOptions) {
    this.options = options
  }

  private get db() {
    return this.options.managers.db
  }

  register(provider: string, executor: ReviewExecutor): void {
    this.executors.set(provider, executor)
  }

  /** 在调用方的事务里建一条待批的审批；提交后调用方要 announce */
  create(input: NewReview): Review {
    const now = this.options.now()
    const result = this.db
      .prepare(
        'INSERT INTO reviews(state, manager_id, provider, expires_at, body) VALUES(?,?,?,?,?)',
      )
      .run('pending', input.requestedBy.managerId, input.provider, input.expiresAt, '{}')
    const review: Review = {
      ...input,
      reviewId: `A-${Number(result.lastInsertRowid)}`,
      revision: 1,
      state: 'pending',
      createdAt: now,
    }
    this.save(review)
    return review
  }

  private save(review: Review): void {
    this.db
      .prepare('UPDATE reviews SET state=?, body=? WHERE seq=?')
      .run(review.state, JSON.stringify(review), seqOf(review.reviewId))
  }

  get(reviewId: string): Review | null {
    const seq = seqOf(reviewId)
    if (seq === null) return null
    const row = this.db.prepare('SELECT body FROM reviews WHERE seq=?').get(seq)
    return row ? (JSON.parse(String(row.body)) as Review) : null
  }

  list(
    filter: { states?: ReviewState[]; managerId?: string; before?: string },
    limit: number,
  ): Review[] {
    const where: string[] = []
    const values: (string | number)[] = []
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => '?').join(',')})`)
      values.push(...filter.states)
    }
    if (filter.managerId) {
      where.push('manager_id=?')
      values.push(filter.managerId)
    }
    const before = filter.before ? seqOf(filter.before) : null
    if (before !== null) {
      where.push('seq<?')
      values.push(before)
    }
    return this.db
      .prepare(
        `SELECT body FROM reviews ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(...values, limit)
      .map((row) => JSON.parse(String(row.body)) as Review)
  }

  /** 待批的条数（界面的入口计数用） */
  pendingCount(managerId?: string): number {
    const row = managerId
      ? this.db
          .prepare("SELECT count(*) AS n FROM reviews WHERE state='pending' AND manager_id=?")
          .get(managerId)
      : this.db.prepare("SELECT count(*) AS n FROM reviews WHERE state='pending'").get()
    return Number(row?.n ?? 0)
  }

  announce(review: Review): void {
    this.options.announce(REVIEWS_NOTIFICATION.changed, {
      reviewId: review.reviewId,
      revision: review.revision,
      managerId: review.requestedBy.managerId,
    })
    try {
      this.executors.get(review.provider)?.changed?.(review)
    } catch (error) {
      this.options.log(`审批变更的后续处理出错：${(error as Error).message}`)
    }
  }

  /** 在事务里把待批的改成结果，交给执行方；不是待批的原样返回 null */
  private settle(
    review: Review,
    state: Exclude<ReviewState, 'pending'>,
    extra: Pick<Review, 'decidedBy' | 'reason'> = {},
  ): Review {
    const next: Review = {
      ...review,
      ...extra,
      state,
      revision: review.revision + 1,
      decidedAt: this.options.now(),
    }
    if (!next.reason) delete next.reason
    this.save(next)
    this.executors.get(review.provider)?.settled(next)
    return next
  }

  private finish(review: Review): void {
    this.announce(review)
    try {
      this.executors.get(review.provider)?.after?.(review)
    } catch (error) {
      this.options.log(`审批结果的后续处理出错：${(error as Error).message}`)
    }
  }

  decide(
    reviewId: string,
    decision: 'approve' | 'reject',
    expectedRevision: number,
    by: NonNullable<Review['decidedBy']>,
    reason?: string,
  ): Review {
    let expired: Review | null = null
    const next = this.options.managers.transaction(() => {
      const review = this.get(reviewId) ?? fail('review_not_found')
      if (review.revision !== expectedRevision) fail('review_revision_conflict')
      if (review.state !== 'pending') fail('review_not_pending')
      if (review.expiresAt <= this.options.now()) {
        expired = this.settle(review, 'expired')
        return null
      }
      return this.settle(review, decision === 'approve' ? 'approved' : 'rejected', {
        decidedBy: by,
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      })
    })
    if (expired) {
      this.finish(expired)
      return fail('review_expired')
    }
    const decided = next as Review
    this.finish(decided)
    return decided
  }

  /** 发起方撤下（比如经理撤回发言）；在调用方的事务里，提交后调用方 announce */
  cancelInTransaction(reviewId: string, reason?: string): Review | null {
    const review = this.get(reviewId)
    if (!review || review.state !== 'pending') return null
    const next: Review = {
      ...review,
      state: 'canceled',
      revision: review.revision + 1,
      decidedAt: this.options.now(),
      ...(reason ? { reason } : {}),
    }
    this.save(next)
    return next
  }

  /**
   * 批准后执行方照办失败（比如飞书发送被拒）：在审批上记下原因，revision 加一并通知，
   * 界面和飞书卡片据此标“已批准 · 发送失败”。状态仍是 approved；不是批准的、已记过的不动
   */
  executionFailed(reviewId: string, error: string): void {
    const next = this.options.managers.transaction(() => {
      const review = this.get(reviewId)
      if (review?.state !== 'approved' || review.execution) return null
      const updated: Review = {
        ...review,
        revision: review.revision + 1,
        execution: { state: 'failed', error: error.slice(0, 128), at: this.options.now() },
      }
      this.save(updated)
      return updated
    })
    if (next) this.announce(next)
  }

  /** 把过期的待批审批标成 expired */
  expire(): void {
    const now = this.options.now()
    const due = this.db
      .prepare("SELECT body FROM reviews WHERE state='pending' AND expires_at<=? ORDER BY seq")
      .all(now)
      .map((row) => JSON.parse(String(row.body)) as Review)
    for (const one of due) {
      const settled = this.options.managers.transaction(() => {
        const review = this.get(one.reviewId)
        return review?.state === 'pending' ? this.settle(review, 'expired') : null
      })
      if (settled) this.finish(settled)
    }
  }
}

function seqOf(reviewId: string): number | null {
  const match = /^A-([1-9][0-9]{0,15})$/.exec(reviewId)
  return match ? Number(match[1]) : null
}

/** litch/reviews/* 方法：校验声明、管理员权限和参数形状 */
export class DeviceReviewsRpc {
  private readonly reviews: DeviceReviews
  constructor(reviews: DeviceReviews) {
    this.reviews = reviews
  }

  call(method: string, raw: unknown, access: { declared: boolean; admin: boolean }): unknown {
    if (!access.declared)
      throw new DeviceError('extensionRequired', `${method} requires ${REVIEWS_EXTENSION}`, {
        method,
        required: [REVIEWS_EXTENSION],
      })
    if (!isReviewsMethod(method)) throw new ProtocolError(-32601, 'Unknown reviews method')
    if (!access.admin && !REVIEWS_PUBLIC_READS.has(method))
      throw new DeviceError('deviceAdminRequired', 'This operation requires a device administrator')
    const args = <K extends ReviewsMethod>(type: K): ReviewsRequests[K]['params'] => {
      const params = raw === undefined ? {} : raw
      if (!isReviewsMethodParams(type, params))
        throw new ProtocolError(-32602, 'Invalid reviews request parameters')
      return params
    }
    switch (method) {
      case M.list: {
        const input = args(method)
        const limit = input.limit ?? LIST_DEFAULT
        const page = this.reviews.list(input, limit + 1)
        const reviews = page.slice(0, limit)
        const last = reviews.at(-1)
        return { reviews, ...(page.length > limit && last ? { next: last.reviewId } : {}) }
      }
      case M.get:
        return { review: this.reviews.get(args(method).reviewId) ?? fail('review_not_found') }
      case M.decide: {
        const input = args(method)
        return {
          review: this.reviews.decide(
            input.reviewId,
            input.decision,
            input.expectedRevision,
            { via: 'litch' },
            input.reason,
          ),
        }
      }
    }
  }
}
