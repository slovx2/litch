// 浏览器面板上“代理请你登录”的卡片：这个会话的有哪些、先出哪条。纯函数，单独测（test/passwords-logic.test.mjs）。
import { type BrowserOwner, type BrowserSignInRequest, ownerKey } from './bridge.ts'

/** 这个会话里的卡片：眼前这个标签的排最前，其余新的在前 */
export function signInsFor(
  requests: readonly BrowserSignInRequest[],
  owner: BrowserOwner,
  currentTabId: string | null,
): BrowserSignInRequest[] {
  const key = ownerKey(owner)
  return requests
    .filter((one) => ownerKey({ deviceId: one.deviceId, threadId: one.threadId }) === key)
    .sort(
      (a, b) => Number(b.tabId === currentTabId) - Number(a.tabId === currentTabId) || b.at - a.at,
    )
}

/** 两段的公共后缀里常见的（co.uk、com.cn……）：可注册域名要多带一段。只为卡片上突出显示，不求全 */
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
 * 卡片上的来源拆成三段：前面淡的（https://accounts.）、突出的可注册域名（google.com）、后面淡的端口（:8443）。
 * IP 地址、localhost、只有一段的主机名整个突出；认不出的来源整个放在 main 里
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
  const plain = /^[\d.]+$/.test(host) || host.startsWith('[') || labels.length <= 2
  if (plain) return { lead, main: host, tail }
  const lastTwo = labels.slice(-2).join('.')
  const take = TWO_PART_SUFFIX.has(lastTwo) ? 3 : 2
  if (labels.length <= take) return { lead, main: host, tail }
  return {
    lead: `${lead}${labels.slice(0, -take).join('.')}.`,
    main: labels.slice(-take).join('.'),
    tail,
  }
}

/** 预检不过的原因里认得的几种，卡片上各有一句话；认不出的说一句笼统的 */
export const FILL_BLOCKS = [
  'no_form',
  'not_user_visible',
  'locator_invalid',
  'insecure',
  'verification',
  'unavailable',
] as const

export type FillBlock = (typeof FILL_BLOCKS)[number]

export const knownBlock = (code: string): FillBlock | null =>
  (FILL_BLOCKS as readonly string[]).includes(code) ? (code as FillBlock) : null

/** 定时任务的卡片还剩几分钟过期（不到一分钟算 1，过了是 0） */
export const minutesLeft = (expiresAt: number, now: number): number =>
  expiresAt <= now ? 0 : Math.ceil((expiresAt - now) / 60_000)
