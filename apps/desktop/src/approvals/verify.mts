// 手机的答复由桌面端自己验（设备服务不可信，只转交）。主进程里内置浏览器的登录卡片收到核心交来的答复后调
// verifyPhoneAnswer(card, answer)：不过的丢掉、卡片接着等。签名内容和算法在 packages/protocol/src/client-approvals.mts。
//
// 只认：自己发出去的卡片号、随机数对得上（用一次作废）、没过期、签的源和账号和自己卡片上的一样、
// 定时任务的卡片才许“以后直接用”、签名能用记下的这台手机的批准钥匙验过。
// 没记过这个手机号的：验过签名就记下、当次生效（先信任、后核对，决 415），并告诉界面出一条提示。
import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  type ApprovalAnswer,
  approvalSignedText,
  isApprovalAnswer,
  isApprovalKey,
} from '../../../../packages/protocol/src/client-approvals.mjs'
import type { ApprovalNotice } from './ipc.mjs'
import {
  approvalKeyFingerprint,
  randomToken,
  type TrustedPhone,
  type TrustedPhones,
} from './store.mjs'

/** 一张发到手机的卡片在桌面端记着的票据：卡片号、随机数、桌面端号。登录卡片（对话里那张）带着它，核心看到才转给设备 */
export interface ApprovalTicket {
  id: string
  nonce: string
  desktopId: string
}

/** 验签要的卡片内容：主进程自己记着的那份，不用答复里带回来的 */
export interface PhoneCard {
  phone: ApprovalTicket
  /** 页面的真实源 */
  origin: string
  /** 卡片上列的账号（只看 ref） */
  accounts: readonly { ref: string }[]
  /** 定时任务的回合才有：这时才许勾“以后直接用” */
  taskId?: string | null
  /** 毫秒；不限时是 null */
  expiresAt?: number | null
  /** 会话所在的设备：第一次批准时记下“经哪台设备” */
  deviceId?: string
}

/** 为什么不认 */
export type PhoneRejection =
  /** 主进程还没装好（没有数据目录） */
  | 'unavailable'
  /** 答复的形状不对 */
  | 'shape'
  /** 卡片号对不上 */
  | 'card'
  /** 这张卡片的随机数已经用过了 */
  | 'replay'
  | 'expired'
  /** 选的账号不在卡片上 */
  | 'account'
  /** 不是定时任务的卡片却勾了“以后直接用” */
  | 'remember'
  /** 签名验不过 */
  | 'signature'
  /** 这个手机号记下的钥匙不是这一把（或者已经对不上过、两把都不认） */
  | 'keyMismatch'

export type PhoneVerdict =
  | {
      ok: true
      phoneId: string
      /** 选的账号（卡片里的 ref）；拒绝是 null */
      choice: string | null
      remember: boolean
      /** 这次是第一次批准记下的钥匙 */
      firstSeen: boolean
    }
  | { ok: false; why: PhoneRejection }

/** 要告诉界面的事：第一次记下了一台手机，或者某台手机的钥匙对不上 */
export type PhoneNotice = ApprovalNotice

export interface PhoneApprovalsOptions {
  store: TrustedPhones
  now?: () => number
  /** 第一次记下、钥匙对不上时调：界面出一条不挡事的提示 */
  notice?: (notice: PhoneNotice) => void
  /** 记下的手机变了：设置页刷新 */
  changed?: () => void
  log?: (line: string) => void
}

/** ed25519 的 SPKI 前缀，后面接 32 字节原始公钥 */
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

function signatureOk(answer: ApprovalAnswer, card: PhoneCard): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI, Buffer.from(answer.approvalKey, 'base64')]),
      format: 'der',
      type: 'spki',
    })
    const text = approvalSignedText({ ...card.phone, origin: card.origin }, answer)
    return verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(answer.signature, 'base64'))
  } catch {
    return false
  }
}

/** 手机名：去掉控制字符，截到 64 个字；没有就用手机号 */
const nameOf = (answer: ApprovalAnswer): string => {
  const plain = (answer.phoneName ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  return plain ? plain.slice(0, 64) : answer.phoneId
}

export class PhoneApprovals {
  private readonly store: TrustedPhones
  private readonly now: () => number
  private readonly options: PhoneApprovalsOptions
  /** 用过的随机数（成功验过的那张卡片的）。只在内存：卡片本来就活不过这个进程 */
  private readonly used = new Set<string>()

  constructor(options: PhoneApprovalsOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.options = options
  }

  /** 给一张要发到手机的卡片出票据 */
  ticket(): ApprovalTicket {
    return { id: randomToken(), nonce: randomToken(), desktopId: this.store.desktopId }
  }

  verify(card: PhoneCard, answer: unknown): PhoneVerdict {
    if (!isApprovalAnswer(answer)) return { ok: false, why: 'shape' }
    const { phone } = card
    if (answer.id !== phone.id || phone.desktopId !== this.store.desktopId)
      return { ok: false, why: 'card' }
    if (this.used.has(phone.nonce)) return { ok: false, why: 'replay' }
    if (card.expiresAt != null && this.now() >= card.expiresAt) return { ok: false, why: 'expired' }
    if (answer.ref !== null && !card.accounts.some((account) => account.ref === answer.ref))
      return { ok: false, why: 'account' }
    if (answer.remember && !card.taskId) return { ok: false, why: 'remember' }
    // 先验签名（用答复带的钥匙），再看认不认这把钥匙：签名都不对的不该动记下的东西
    if (!signatureOk(answer, card)) return { ok: false, why: 'signature' }
    const known = this.store.get(answer.phoneId)
    let firstSeen = false
    if (!known) {
      firstSeen = true
      const added: TrustedPhone = {
        phoneId: answer.phoneId,
        name: nameOf(answer),
        approvalKey: answer.approvalKey,
        source: 'firstApproval',
        deviceId: card.deviceId ?? null,
        addedAt: this.now(),
        lastApprovedAt: null,
        conflict: false,
      }
      this.store.put(added)
      this.options.log?.(`记下了手机 ${added.phoneId} 的批准钥匙（第一次批准）`)
      this.options.notice?.({
        kind: 'firstSeen',
        phoneId: added.phoneId,
        name: added.name,
        fingerprint: approvalKeyFingerprint(added.approvalKey),
      })
    } else if (known.conflict || known.approvalKey !== answer.approvalKey) {
      // 第一次批准记下的对不上了：两把都不认；扫码核对过的不让顶掉，只不认这一把
      if (!known.conflict && known.source === 'firstApproval') {
        this.store.put({ ...known, conflict: true })
        this.options.changed?.()
      }
      this.options.log?.(`手机 ${known.phoneId} 带来的批准钥匙和记下的对不上，不认`)
      this.options.notice?.({ kind: 'mismatch', phoneId: known.phoneId, name: known.name })
      return { ok: false, why: 'keyMismatch' }
    }
    this.used.add(phone.nonce)
    const trusted = this.store.get(answer.phoneId)
    if (trusted) this.store.put({ ...trusted, lastApprovedAt: this.now() })
    this.options.changed?.()
    return {
      ok: true,
      phoneId: answer.phoneId,
      choice: answer.decision === 'approve' ? answer.ref : null,
      remember: answer.remember,
      firstSeen,
    }
  }

  /** 扫码绑定时人核对过确认码、点了允许：记下（换掉这个手机号原来的，包括对不上的那条） */
  trustFromPairing(input: {
    phoneId: string
    name: string
    approvalKey: string
    deviceId: string | null
  }): void {
    this.store.put({
      ...input,
      source: 'pairing',
      addedAt: this.now(),
      lastApprovedAt: null,
      conflict: false,
    })
    this.options.log?.(`记下了手机 ${input.phoneId} 的批准钥匙（扫码时核对过）`)
    this.options.changed?.()
  }

  /** 设置里删掉、撤销手机时：忘掉它的钥匙 */
  forget(phoneId: string): boolean {
    const removed = this.store.remove(phoneId)
    if (removed) this.options.changed?.()
    return removed
  }

  phones() {
    return this.store.list()
  }
}

/**
 * 扫码时记下批准公钥之前自己重算一遍（算法在 packages/protocol/src/device-pairing.mts）：手机号是公钥二进制的 SHA-256 前 8 字节，
 * 确认码是 SHA-256(配对号 \n 公钥行 \n 批准公钥) 的前 4 字节按大端模一百万。两样都和人核对过的对得上才算数：
 * 设备不可信，它可以报一个对的确认码、却塞一把别的批准公钥
 */
export function pairingKeyMatches(input: {
  pairId: string
  phoneId: string
  publicKey: string
  approvalKey: string
  code: string
}): boolean {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(input.publicKey)
  if (!match?.[1] || !isApprovalKey(input.approvalKey)) return false
  const phoneId = createHash('sha256')
    .update(Buffer.from(match[1], 'base64'))
    .digest('hex')
    .slice(0, 16)
  const digest = createHash('sha256')
    .update(`${input.pairId}\n${input.publicKey}\n${input.approvalKey}`, 'utf8')
    .digest()
  const code = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
  return phoneId === input.phoneId && code === input.code
}

// ---------- 主进程里只有一份 ----------

let installed: PhoneApprovals | null = null

/** 主进程起来时装上（approvals/main.mts）；测试里换成自己的 */
export function installPhoneApprovals(approvals: PhoneApprovals | null): void {
  installed = approvals
}

/** 给一张要发到手机的卡片出票据。还没装好（没有数据目录）时是 null，这张卡片就不发到手机 */
export function newApprovalTicket(): ApprovalTicket | null {
  return installed?.ticket() ?? null
}

/** 验手机的答复（22 号设计 12.2 第 3 条） */
export function verifyPhoneAnswer(card: PhoneCard, answer: unknown): PhoneVerdict {
  return installed ? installed.verify(card, answer) : { ok: false, why: 'unavailable' }
}
