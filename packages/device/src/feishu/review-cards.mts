// 飞书里的审批卡片：发言审批建好后，设备给本应用标了审批人的已绑定用户各私聊发一张卡片，
// 带“批准”“拒绝”两个按钮。按钮回调（card.action.trigger）经长连接回到设备：核对点的人还是审批人、
// 审批还在待批、卡片上的版本号和当前一致，再按“在飞书里批”执行决定。审批有了结果（不管在哪批的、撤下、过期），
// 设备把每张卡片改成结果；批准后没发出去的再改成“已批准 · 发送失败”。卡片是 JSON 2.0，开了 update_multi 才能用接口更新。
import type { Review } from '../../../protocol/src/reviews.mjs'
import type { DeviceReviews } from '../reviews.mjs'
import type { FeishuApi } from './api.mjs'
import type { FeishuBindings } from './bindings.mjs'
import type { FeishuStore } from './store.mjs'

/** 卡片里每段正文最多显示多少字、最多显示几段 */
const PART_CHARS = 1500
const PARTS_SHOWN = 5

export interface FeishuReviewCardsOptions {
  store: FeishuStore
  bindings: FeishuBindings
  reviews: DeviceReviews
  api: (appId: string) => FeishuApi | null
  /** 秒 */
  now: () => number
  log: (message: string) => void
  /** 经理的名字（卡片上写是谁要发） */
  managerName: (managerId: string) => string
}

interface NoticeBody {
  messageId?: string
  chatId: string
  sentAt?: number
  updatedAt?: number
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 卡片 Markdown 里不让正文变成 @ 或字体标签 */
const plain = (text: string) => text.replace(/<(?=\/?\s*(at|font|a|link)\b)/gi, '<\u200b')
const clip = (text: string, max: number) =>
  [...text].length > max ? `${[...text].slice(0, max).join('')}…` : text

const STATE_TEXT: Record<Review['state'], string> = {
  pending: '待批',
  approved: '已批准',
  rejected: '已拒绝',
  canceled: '已撤下',
  expired: '已过期',
}
/** 批准后没发出去的原因（发件行的 error）；卡片只有中文，认不出的写原因代码 */
const SEND_FAILURE_TEXT: Record<string, string> = {
  payload_changed: '内容与审批时不一致',
  chat_unavailable: '机器人已不在群里或群已解散',
  user_unbound: '对方已解除私聊绑定',
  app_inactive: '应用已停用或未连接',
  review_mismatch: '审批与发言对不上',
  permission: '应用缺少权限',
  not_found: '目标在飞书上不存在',
  platform: '飞书服务异常',
  invalid: '飞书不接受这条内容',
  credential_rejected: 'App Secret 无效',
}
const sendFailure = (error: string) => SEND_FAILURE_TEXT[error] ?? plain(clip(error, 64))

const STATE_TEMPLATE: Record<Review['state'], string> = {
  pending: 'orange',
  approved: 'green',
  rejected: 'red',
  canceled: 'grey',
  expired: 'grey',
}

export class FeishuReviewCards {
  private readonly options: FeishuReviewCardsOptions
  private readonly running = new Set<Promise<void>>()

  constructor(options: FeishuReviewCardsOptions) {
    this.options = options
  }

  private get db() {
    return this.options.store.managers.db
  }

  // —— 卡片内容 ——

  private card(review: Review, decidedByName?: string): Json {
    const preview = review.preview
    const now = this.options.now()
    // 批准了但没发出去
    const failed = review.state === 'approved' && review.execution?.state === 'failed'
    const facts = [
      `**发到**：${plain(preview.target.kind === 'chat' ? preview.target.name : `私聊 ${preview.target.name}`)}`,
      `**经理**：${plain(this.options.managerName(review.requestedBy.managerId) || review.requestedBy.managerId)}`,
      `**身份**：${preview.actingAs.type === 'bot' ? '机器人' : plain(preview.actingAs.name)}`,
      ...(preview.mentions.length
        ? [`**@**：${plain(preview.mentions.map((one) => one.name).join('、'))}`]
        : []),
      ...(preview.replyTo
        ? [
            `**回复**：${plain(clip(preview.replyTo.text?.trim() || preview.replyTo.messageId, 200))}`,
          ]
        : []),
    ]
    const parts = preview.parts
      .slice(0, PARTS_SHOWN)
      .map((part) =>
        part.text !== undefined
          ? plain(clip(part.text, PART_CHARS))
          : `［${part.format === 'image' ? '图片' : '文件'}］${plain(part.name ?? '')}`,
      )
    if (preview.parts.length > PARTS_SHOWN)
      parts.push(`（共 ${preview.parts.length} 条，其余在 Litch 里看）`)
    const elements: Json[] = [
      { tag: 'markdown', content: facts.join('\n') },
      { tag: 'hr' },
      ...parts.map((content) => ({ tag: 'markdown', content })),
      { tag: 'hr' },
    ]
    if (review.state === 'pending') {
      const hours = Math.max(1, Math.round((review.expiresAt - now) / 3600))
      elements.push({
        tag: 'markdown',
        content: `约 ${hours} 小时后过期。批准后按上面的内容原样发出。`,
      })
      const button = (label: string, decision: 'approve' | 'reject', type: string) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: label },
        type,
        behaviors: [
          {
            type: 'callback',
            value: {
              litch: 'review',
              reviewId: review.reviewId,
              revision: review.revision,
              decision,
            },
          },
        ],
      })
      elements.push({
        tag: 'column_set',
        columns: [
          { tag: 'column', width: 'auto', elements: [button('批准', 'approve', 'primary_filled')] },
          { tag: 'column', width: 'auto', elements: [button('拒绝', 'reject', 'danger')] },
        ],
      })
    } else {
      const via =
        review.decidedBy?.via === 'feishu'
          ? `${decidedByName ? `由 ${plain(decidedByName)} ` : ''}在飞书里批`
          : review.decidedBy?.via === 'litch'
            ? '在 Litch 里批'
            : ''
      const line = `**${STATE_TEXT[review.state]}${failed ? ' · 发送失败' : ''}**${via && review.state !== 'expired' && review.state !== 'canceled' ? ` · ${via}` : ''}${failed && review.execution ? `\n没发出去：${sendFailure(review.execution.error)}` : ''}${review.reason ? `\n理由：${plain(clip(review.reason, 500))}` : ''}`
      elements.push({ tag: 'markdown', content: line })
    }
    return {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: `发言审批 ${review.reviewId}` },
        subtitle: {
          tag: 'plain_text',
          content: failed ? `${STATE_TEXT[review.state]} · 发送失败` : STATE_TEXT[review.state],
        },
        template: failed ? 'red' : STATE_TEMPLATE[review.state],
      },
      body: { elements },
    }
  }

  private nameOf(appId: string, review: Review): string | undefined {
    const who = review.decidedBy?.via === 'feishu' ? review.decidedBy.who : undefined
    return who ? this.options.bindings.record(appId, who)?.name || undefined : undefined
  }

  // —— 审批变化 ——

  /** 审批新建、撤下、有结果时（DeviceReviews 通知客户端的同时） */
  changed(review: Review): void {
    if (review.preview.provider !== 'feishu') return
    if (review.state === 'pending') {
      if (review.revision === 1) this.background(() => this.send(review))
      return
    }
    this.background(() => this.update(review))
  }

  private notices(reviewId: string): { openId: string; appId: string; body: NoticeBody }[] {
    return this.db
      .prepare('SELECT open_id, app_id, body FROM feishu_review_notices WHERE review_id=?')
      .all(reviewId)
      .map((row) => ({
        openId: String(row.open_id),
        appId: String(row.app_id),
        body: JSON.parse(String(row.body)) as NoticeBody,
      }))
  }

  private saveNotice(
    reviewId: string,
    openId: string,
    appId: string,
    state: string,
    body: NoticeBody,
  ): void {
    this.db
      .prepare(
        `INSERT INTO feishu_review_notices VALUES(?,?,?,?,?)
         ON CONFLICT(review_id, open_id) DO UPDATE SET state=excluded.state, body=excluded.body`,
      )
      .run(reviewId, openId, appId, state, JSON.stringify(body))
  }

  private async send(review: Review): Promise<void> {
    const appId = review.preview.appId
    const api = this.options.api(appId)
    if (!api) return
    const known = new Set(this.notices(review.reviewId).map((one) => one.openId))
    // 审批人，加上以自己名义发的那个人（不管是不是审批人都能批自己的）
    const recipients = [...this.options.bindings.approvers(appId)]
    const acting = review.preview.actingAs
    if (acting.type === 'user' && !recipients.some((one) => one.openId === acting.openId)) {
      const owner = this.options.bindings.bound(appId, acting.openId)
      if (owner) recipients.push(owner)
    }
    for (const approver of recipients) {
      if (known.has(approver.openId) || !approver.p2pChatId) continue
      const chatId = approver.p2pChatId
      this.saveNotice(review.reviewId, approver.openId, appId, 'sending', { chatId })
      // 发卡片前审批可能已经有结果：照当前状态发
      const current = this.options.reviews.get(review.reviewId) ?? review
      try {
        const sent = await api.data('POST', '/open-apis/im/v1/messages', {
          query: { receive_id_type: 'chat_id' },
          body: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify(this.card(current, this.nameOf(appId, current))),
            uuid: `rv-${review.reviewId}-${approver.openId.slice(3, 33)}`,
          },
        })
        const messageId = typeof sent.message_id === 'string' ? sent.message_id : undefined
        this.saveNotice(review.reviewId, approver.openId, appId, 'sent', {
          chatId,
          ...(messageId ? { messageId } : {}),
          sentAt: this.options.now(),
        })
        this.options.store.audit(appId, this.options.now(), {
          action: 'review_card_sent',
          by: 'device',
          detail: { reviewId: review.reviewId },
        })
        // 发的时候审批又变了（别处批了）：补一次更新
        const after = this.options.reviews.get(review.reviewId)
        if (after && after.revision !== current.revision && messageId)
          await this.patch(api, messageId, after, appId)
      } catch (error) {
        this.saveNotice(review.reviewId, approver.openId, appId, 'failed', { chatId })
        this.options.log(`飞书审批卡片发送失败：${(error as Error).message}`)
      }
    }
  }

  private async patch(
    api: FeishuApi,
    messageId: string,
    review: Review,
    appId: string,
  ): Promise<void> {
    await api.data('PATCH', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      body: { content: JSON.stringify(this.card(review, this.nameOf(appId, review))) },
    })
  }

  private async update(review: Review): Promise<void> {
    const appId = review.preview.appId
    const api = this.options.api(appId)
    if (!api) return
    for (const notice of this.notices(review.reviewId)) {
      if (!notice.body.messageId) continue
      try {
        await this.patch(api, notice.body.messageId, review, appId)
        this.saveNotice(review.reviewId, notice.openId, appId, 'updated', {
          ...notice.body,
          updatedAt: this.options.now(),
        })
      } catch (error) {
        this.options.log(`飞书审批卡片更新失败：${(error as Error).message}`)
      }
    }
  }

  // —— 按钮回调 ——

  /** card.action.trigger：返回值就是给飞书的回调响应（提示加换上的卡片） */
  action(appId: string, data: Json): Json {
    const action = isObject(data.action) ? data.action : {}
    const value = isObject(action.value) ? action.value : {}
    if (value.litch !== 'review') return {}
    const operator = isObject(data.operator) ? data.operator : {}
    const openId = typeof operator.open_id === 'string' ? operator.open_id : ''
    const reviewId = typeof value.reviewId === 'string' ? value.reviewId : ''
    const decision =
      value.decision === 'approve' || value.decision === 'reject' ? value.decision : null
    const revision = typeof value.revision === 'number' ? value.revision : 0
    const { store, bindings, reviews } = this.options
    const now = this.options.now()
    const refuse = (content: string, reason: string, review?: Review | null): Json => {
      store.audit(appId, now, {
        action: 'review_card_refused',
        by: 'feishu',
        detail: { reviewId: reviewId || null, reason },
      })
      return {
        toast: { type: 'error', content },
        ...(review
          ? { card: { type: 'raw', data: this.card(review, this.nameOf(appId, review)) } }
          : {}),
      }
    }
    const review = reviewId ? reviews.get(reviewId) : null
    if (!review || review.preview.appId !== appId || !decision)
      return refuse('这条审批不存在。', 'not_found')
    const binding = bindings.bound(appId, openId)
    const owner =
      review.preview.actingAs.type === 'user' && review.preview.actingAs.openId === openId
    if (!binding || !(binding.approver || owner))
      return refuse('你不是这个应用的审批人，不能批。', 'not_approver', review)
    if (review.state !== 'pending')
      return refuse(`这条审批${STATE_TEXT[review.state]}。`, 'not_pending', review)
    if (review.revision !== revision)
      return refuse('审批已经变了，请看最新的内容。', 'stale', review)
    try {
      const decided = reviews.decide(reviewId, decision, revision, { via: 'feishu', who: openId })
      store.audit(appId, now, {
        action: 'review_card_decided',
        by: 'feishu',
        detail: { reviewId, decision },
      })
      return {
        toast: {
          type: 'success',
          content: decision === 'approve' ? '已批准，消息会原样发出。' : '已拒绝。',
        },
        card: { type: 'raw', data: this.card(decided, binding.name) },
      }
    } catch (error) {
      const latest = reviews.get(reviewId)
      const reason = (error as Error).message
      return refuse(
        reason === 'review_expired' ? '这条审批已过期。' : '没批成，请在 Litch 里看最新状态。',
        reason,
        latest,
      )
    }
  }

  private background(work: () => Promise<void>): void {
    const running = work().catch((error: Error) =>
      this.options.log(`飞书审批卡片处理出错：${error.message}`),
    )
    this.running.add(running)
    void running.finally(() => this.running.delete(running))
  }

  /** 测试：等后台的卡片发送和更新做完 */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running])
  }
}
