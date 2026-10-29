// 手机上批准（clientApprovals 扩展）在设备进程里的部分：桌面端挂过来的卡片（只在内存），转给手机看，
// 手机的答复原样转回发卡片的那条连接。约定在 packages/protocol/src/client-approvals.mts，规则在
// protocol/extensions/client-approvals.json。
//
// 设备进程不可信（代理就跑在这台机器上、和它是同一个用户），所以这里不验签名、不记批准钥匙：
// 只查形状、记着卡片是哪条连接开的，验签全在桌面端。
import {
  APPROVAL_ACCOUNTS_MAX,
  APPROVAL_ANSWER,
  APPROVAL_ANSWERED,
  APPROVAL_ANSWERS_MAX,
  APPROVAL_CHANGED,
  APPROVAL_CLOSE,
  APPROVAL_ERROR,
  APPROVAL_LIST,
  APPROVAL_MAX_PER_CONNECTION,
  APPROVAL_OPEN,
  APPROVAL_TEXT_MAX,
  type ApprovalAccount,
  type ApprovalAnswer,
  type ApprovalCard,
  type ApprovalCardView,
  type ApprovalErrorReason,
  type BrowserSignInSummary,
  isApprovalAnswer,
  isApprovalRef,
  isApprovalToken,
} from '../../protocol/src/client-approvals.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { isObject } from './wire.mjs'

/** 一条客户端连接：发卡片的、答卡片的都是它 */
export interface ApprovalPeer {
  /** 握手时声明了这项扩展没有 */
  declares(extension: string): boolean
  /** 只发给这条连接（声明过 extension 才发） */
  announce(method: string, params: unknown, extension?: string): void
}

export interface ApprovalsHost {
  /** 发给所有声明了 extension 的连接 */
  announce(method: string, params: unknown, extension: string): void
  changed?(threadId: string): void
  log(line: string): void
}

/** 定时器。测试换成可以拨的假时钟 */
export interface ApprovalsClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: ApprovalsClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/** setTimeout 能等的最长时间（再长会溢出成立刻触发），过期时间更远的分段等 */
const MAX_TIMER_MS = 2 ** 31 - 1

/** litch/approval/* 回的错误：data.reason 是原因；参数不对、unknownApproval 是 -32602，其余 -32000 */
export class ApprovalError extends Error {
  readonly code: number
  readonly data?: { reason: ApprovalErrorReason }

  constructor(reason: ApprovalErrorReason | null, message: string) {
    super(message)
    this.code = reason === null || reason === APPROVAL_ERROR.unknownApproval ? -32602 : -32000
    if (reason) this.data = { reason }
  }
}

interface Held {
  card: ApprovalCardView
  owner: ApprovalPeer
  answers: number
  timer: unknown
}

export class DeviceApprovals {
  private readonly host: ApprovalsHost
  private readonly clock: ApprovalsClock
  private readonly cards = new Map<string, Held>()

  constructor(host: ApprovalsHost, clock: ApprovalsClock = REAL_CLOCK) {
    this.host = host
    this.clock = clock
  }

  /** 聚合面交来的 litch/approval/* 请求 */
  call(peer: ApprovalPeer, method: string, params: unknown): unknown {
    const given = isObject(params) ? params : {}
    switch (method) {
      case APPROVAL_OPEN:
        this.open(peer, params)
        return {}
      case APPROVAL_CLOSE:
        if (!isApprovalToken(given.id)) throw new ApprovalError(null, 'id 不是卡片号')
        this.close(peer, given.id)
        return {}
      case APPROVAL_LIST: {
        if (given.threadId !== undefined && typeof given.threadId !== 'string')
          throw new ApprovalError(null, 'threadId 要是字符串')
        return { data: this.list(given.threadId) }
      }
      case APPROVAL_ANSWER:
        this.answer(params)
        return {}
      default:
        throw new ApprovalError(null, `不认识 ${method}`)
    }
  }

  private open(peer: ApprovalPeer, params: unknown): void {
    if (!peer.declares(EXTENSION.clientApprovals))
      throw new ApprovalError(
        APPROVAL_ERROR.undeclared,
        `握手时在 capabilities.litchExtensions 里声明了 ${EXTENSION.clientApprovals} 才能挂卡片`,
      )
    const card = cardOf(params)
    if (!card) throw new ApprovalError(null, '卡片的形状不对')
    const now = this.clock.now()
    if (card.expiresAt !== null && card.expiresAt <= now)
      throw new ApprovalError(APPROVAL_ERROR.expired, '这张卡片已经过期了')
    const known = this.cards.get(card.id)
    if (known && known.owner !== peer)
      throw new ApprovalError(APPROVAL_ERROR.duplicate, `卡片号 ${card.id} 已经被别的连接用了`)
    if (!known && this.countOf(peer) >= APPROVAL_MAX_PER_CONNECTION)
      throw new ApprovalError(APPROVAL_ERROR.tooMany, '这条连接挂的卡片太多了')
    if (known) {
      this.clock.clearTimeout(known.timer)
      // 换了会话：原来那个会话上的这张没了
      if (known.card.threadId !== card.threadId) {
        this.cards.delete(card.id)
        this.changed(known.card.threadId)
      }
    }
    const held: Held = {
      card: { ...card, openedAt: known?.card.openedAt ?? now },
      owner: peer,
      answers: known?.answers ?? 0,
      timer: null,
    }
    this.cards.set(card.id, held)
    if (card.expiresAt !== null) this.expireAt(held, card.expiresAt)
    this.changed(card.threadId)
  }

  /** 到点收掉；太远的分段等 */
  private expireAt(held: Held, at: number): void {
    const wait = Math.max(0, at - this.clock.now())
    held.timer = this.clock.setTimeout(
      () => {
        if (this.cards.get(held.card.id) !== held) return
        if (this.clock.now() < at) {
          this.expireAt(held, at)
          return
        }
        this.drop(held)
      },
      Math.min(wait, MAX_TIMER_MS),
    )
  }

  private close(peer: ApprovalPeer, id: string): void {
    const held = this.cards.get(id)
    if (held?.owner === peer) this.drop(held)
  }

  list(threadId: string | undefined): ApprovalCardView[] {
    const data: ApprovalCardView[] = []
    for (const held of this.cards.values())
      if (threadId === undefined || held.card.threadId === threadId) data.push(viewOf(held))
    return data.sort((a, b) => a.openedAt - b.openedAt)
  }

  private answer(params: unknown): void {
    if (!isApprovalAnswer(params)) throw new ApprovalError(null, '答复的形状不对')
    const held = this.cards.get(params.id)
    if (!held || (held.card.expiresAt !== null && held.card.expiresAt <= this.clock.now()))
      throw new ApprovalError(APPROVAL_ERROR.unknownApproval, `没有卡片 ${params.id}`)
    if (held.answers >= APPROVAL_ANSWERS_MAX)
      throw new ApprovalError(APPROVAL_ERROR.tooMany, '这张卡片答的次数太多了')
    if (params.ref !== null && !held.card.summary.accounts.some((a) => a.ref === params.ref))
      throw new ApprovalError(null, `卡片上没有账号 ${params.ref}`)
    held.answers++
    held.owner.announce(APPROVAL_ANSWERED, answerOf(params), EXTENSION.clientApprovals)
    this.host.log(`卡片 ${params.id}：转交了手机 ${params.phoneId} 的答复（${params.decision}）`)
  }

  /** 一条连接断了：它挂的卡片都收掉 */
  left(peer: ApprovalPeer): void {
    for (const held of [...this.cards.values()]) if (held.owner === peer) this.drop(held)
  }

  /** 设备进程关闭：都收掉，不再通知 */
  shutdown(): void {
    for (const held of this.cards.values()) this.clock.clearTimeout(held.timer)
    this.cards.clear()
  }

  private drop(held: Held): void {
    if (this.cards.get(held.card.id) !== held) return
    this.cards.delete(held.card.id)
    this.clock.clearTimeout(held.timer)
    this.changed(held.card.threadId)
  }

  private countOf(peer: ApprovalPeer): number {
    let count = 0
    for (const held of this.cards.values()) if (held.owner === peer) count++
    return count
  }

  private changed(threadId: string): void {
    this.host.changed?.(threadId)
    this.host.announce(
      APPROVAL_CHANGED,
      { threadId, data: this.list(threadId) },
      EXTENSION.clientApprovals,
    )
  }
}

const viewOf = (held: Held): ApprovalCardView => ({
  ...held.card,
  summary: {
    ...held.card.summary,
    accounts: held.card.summary.accounts.map((account) => ({ ...account })),
    task: held.card.summary.task ? { ...held.card.summary.task } : null,
  },
})

/** 只留定义里的键：设备进程转交的不多带别的东西 */
function answerOf(answer: ApprovalAnswer): ApprovalAnswer {
  return {
    id: answer.id,
    ref: answer.ref,
    decision: answer.decision,
    remember: answer.remember,
    phoneId: answer.phoneId,
    ...(answer.phoneName === undefined ? {} : { phoneName: clean(answer.phoneName, 64) }),
    approvalKey: answer.approvalKey,
    signature: answer.signature,
  }
}

/** 去掉控制字符和不可见的格式字符，截到 max 个 UTF-16 码元（不切开代理对） */
function clean(text: string, max: number): string {
  const plain = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** 形状对就整理成卡片（文字清理、截断），不对是 null */
function cardOf(value: unknown): ApprovalCard | null {
  if (!isObject(value)) return null
  const { id, threadId, kind, summary, desktopId, nonce, expiresAt } = value
  if (!isApprovalToken(id) || !isApprovalToken(desktopId) || !isApprovalToken(nonce)) return null
  if (typeof threadId !== 'string' || threadId === '' || kind !== 'browserSignIn') return null
  if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)))
    return null
  const parsed = summaryOf(summary)
  if (!parsed) return null
  return { id, threadId, kind, summary: parsed, desktopId, nonce, expiresAt }
}

function summaryOf(value: unknown): BrowserSignInSummary | null {
  if (!isObject(value)) return null
  const { origin, site, reason, device, accounts, task, fillBlocked } = value
  if (typeof origin !== 'string' || !/^https?:\/\/[^\s/]+$/.test(origin)) return null
  if (typeof site !== 'string' || typeof reason !== 'string' || typeof device !== 'string')
    return null
  if (!Array.isArray(accounts) || accounts.length > APPROVAL_ACCOUNTS_MAX) return null
  const list: ApprovalAccount[] = []
  const refs = new Set<string>()
  for (const account of accounts) {
    if (!isObject(account) || !isApprovalRef(account.ref) || typeof account.masked !== 'string')
      return null
    if (refs.has(account.ref)) return null
    refs.add(account.ref)
    list.push({ ref: account.ref, masked: clean(account.masked, APPROVAL_TEXT_MAX.masked) })
  }
  let parsedTask: BrowserSignInSummary['task'] = null
  if (task !== null) {
    if (!isObject(task) || typeof task.id !== 'string' || typeof task.name !== 'string') return null
    parsedTask = { id: task.id, name: clean(task.name, APPROVAL_TEXT_MAX.task) }
  }
  if (fillBlocked !== null && typeof fillBlocked !== 'string') return null
  return {
    origin,
    site: clean(site, APPROVAL_TEXT_MAX.site),
    reason: clean(reason, APPROVAL_TEXT_MAX.reason),
    device: clean(device, APPROVAL_TEXT_MAX.device),
    accounts: list,
    task: parsedTask,
    fillBlocked: fillBlocked === null ? null : clean(fillBlocked, 200),
  }
}
