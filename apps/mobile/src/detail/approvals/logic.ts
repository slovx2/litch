// 手机批准电脑上的代理登录（22 号设计第八节）：卡片现在能不能答、账号怎么显示、答复怎么拼和签。
// 不碰界面和原生模块：签名经 Signer 交进来，单元测试拿 node:crypto 顶替。
import {
  type ApprovalAnswer,
  type ApprovalCard,
  approvalSignedText,
} from '../../../../../packages/protocol/src/client-approvals.mts'

/** 两段的公共后缀里常见的：可注册域名要多带一段。只为卡片上突出显示，不求全 */
const TWO_PART_SUFFIX = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'com.hk',
  'com.tw',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.sg',
  'co.in',
])

/**
 * 来源拆成三段：前面淡的（https://accounts.）、突出的可注册域名（google.com）、后面淡的端口（:8443）。
 * 和桌面端登录卡片（packages/ui 的 side/browser/sign-in-logic.ts 的 originParts）同一个规则；
 * 那份合进来之后改成直接引用它
 */
export function originParts(origin: string): { lead: string; main: string; tail: string } {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return { lead: '', main: origin, tail: '' }
  }
  const host = url.hostname
  const lead = `${url.protocol}//`
  const tail = url.port ? `:${url.port}` : ''
  const labels = host.split('.')
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || labels.length <= 2)
    return { lead, main: host, tail }
  const take = TWO_PART_SUFFIX.has(labels.slice(-2).join('.')) ? 3 : 2
  if (labels.length <= take) return { lead, main: host, tail }
  return {
    lead: `${lead}${labels.slice(0, -take).join('.')}.`,
    main: labels.slice(-take).join('.'),
    tail,
  }
}

/** 预检不过的原因里认得的（桌面主进程的 SignInBlock 和界面认的几种），各有一句话；认不出的照原样写 */
export const FILL_BLOCKS = [
  'no_form',
  'not_user_visible',
  'locator_invalid',
  'insecure',
  'verification',
  'unavailable',
  'popup_needed',
  'origin_changed',
  'page_changed',
] as const
export type FillBlock = (typeof FILL_BLOCKS)[number]
export const knownBlock = (code: string): FillBlock | null =>
  (FILL_BLOCKS as readonly string[]).includes(code) ? (code as FillBlock) : null

/** 卡片过期了没有。不限时的（普通会话）永远不过期 */
export const isExpired = (card: Pick<ApprovalCard, 'expiresAt'>, now: number): boolean =>
  card.expiresAt !== null && card.expiresAt <= now

/** 还剩多少毫秒；不限时是 null，过了是 0 */
export const remainingMs = (card: Pick<ApprovalCard, 'expiresAt'>, now: number): number | null =>
  card.expiresAt === null ? null : Math.max(0, card.expiresAt - now)

/** 剩下的时间说成“m:ss” */
export function remainingText(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * 卡片上显示的用户名。桌面端给的本来就是打码的；万一给来的不带打码记号，照桌面端同样的规则再打一遍
 * （@ 前留头两个字，不到三个字只留一个），手机上不出现完整用户名（决 416）
 */
export function shownName(masked: string): string {
  if (masked.includes('•')) return masked
  const at = masked.lastIndexOf('@')
  const local = at > 0 ? masked.slice(0, at) : masked
  const domain = at > 0 ? masked.slice(at) : ''
  const chars = [...local]
  const keep = chars.length > 2 ? 2 : Math.min(1, chars.length)
  return `${chars.slice(0, keep).join('')}•••${domain}`
}

/**
 * 手机上能做什么：fill 能挑账号批准；noAccount 这个网站没有已保存的账号，要到电脑上登录；
 * blocked 预检没过（原因在 summary.fillBlocked）；expired 过期了。后三种只能拒绝或放着
 */
export type ApprovalAbility = 'fill' | 'noAccount' | 'blocked' | 'expired'

export function abilityOf(card: ApprovalCard, now: number): ApprovalAbility {
  if (isExpired(card, now)) return 'expired'
  if (card.summary.fillBlocked) return 'blocked'
  return card.summary.accounts.length === 0 ? 'noAccount' : 'fill'
}

/** 人在卡片上选的：ref 是账号（拒绝是 null）；remember 只有定时任务的卡片才算数 */
export interface ApprovalChoice {
  ref: string | null
  remember: boolean
}

/** 签名的一方：这台设备上的手机号、手机名、批准公钥，加上签名（已经过了系统验证） */
export interface Signer {
  phoneId: string
  phoneName: string
  approvalKey: string
  sign(text: string): Promise<string>
}

/**
 * 拼答复并签名。签的是手机看到的这张卡片（id、nonce、desktopId 和摘要里的 origin 原样取卡片上的），
 * 设备改过卡片内容的话，桌面端拿自己记着的对不上就不认
 */
export async function buildAnswer(
  card: ApprovalCard,
  choice: ApprovalChoice,
  signer: Signer,
): Promise<ApprovalAnswer> {
  const decision = choice.ref === null ? 'decline' : 'approve'
  if (decision === 'approve' && !card.summary.accounts.some((each) => each.ref === choice.ref))
    throw new Error('卡片上没有这个账号')
  const signed = {
    ref: choice.ref,
    decision,
    remember: decision === 'approve' && card.summary.task !== null && choice.remember,
    phoneId: signer.phoneId,
  } as const
  return {
    id: card.id,
    ...signed,
    phoneName: signer.phoneName,
    approvalKey: signer.approvalKey,
    signature: await signer.sign(
      approvalSignedText(
        { id: card.id, nonce: card.nonce, desktopId: card.desktopId, origin: card.summary.origin },
        signed,
      ),
    ),
  }
}
