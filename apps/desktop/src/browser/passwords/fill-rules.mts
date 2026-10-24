// Litch 代填（request_sign_in 的方案 B）用的纯规则，主进程和预加载都用，不引 electron，
// 单元测试在 test/passwords-fill.test.mts：
// - 预加载报回的登录表单情况 → 能不能代填（预检）；
// - 同站的认法（表单交去的地方）；
// - 自检时找“那串密码”：不把密码送进每个框架，只送一个滚动哈希（两组随机底数、两个模数），框架里按长度滑窗比对。
//   碰巧撞上的概率约 2^-52，撞上了只是当“不干净”关掉重开，不会放过真的泄露。

import type { SignInBlock } from './signin.mjs'

/** 冻结之前给代理指的元素加的一次性标记（tools-signin.mts 加，sign-in-page.mts 取走） */
export const HINT_ATTRIBUTE = 'data-litch-sign-in'

/** 代填没做成的原因（给代理的固定几种，tools-signin.mts 拼成文字） */
export type FillFailure =
  | 'origin_changed'
  | 'page_changed'
  | 'locator_invalid'
  | 'not_user_visible'
  | 'insecure'
  | 'popup_needed'
  | 'no_answer'
  | 'unavailable'

/** 预加载在一个框架里看到的登录表单（不带任何值） */
export interface LoginReport {
  /** none：没有登录框；ambiguous：不止一个登录表单、没有提示认不出；login：有密码框；username：两步登录的第一步 */
  form: 'none' | 'ambiguous' | 'login' | 'username'
  /** 代理给的编号提示：没给 none；都落在认出的表单里 ok；有落在外面的、类型不对的 invalid */
  hint: 'none' | 'ok' | 'invalid'
  /** 要填的框都看得见：有大小、不透明、不在页面外、中心点上取到的是它自己 */
  visible: boolean
  /** 表单写明的方法（小写），没写是 default；不在表单里是 null。只有写明 get 的算用 GET 交 */
  method: string | null
  /** 表单交去的地址（form.action 解析后的）；不在表单里是 null */
  action: string | null
  /** 页面上有验证码、二次验证的框 */
  otp: boolean
}

/** 本机回环：http 也算安全（同 origin.mts 的 fillableOrigin） */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/

/** 常见的二级公共后缀（co.uk、com.cn 之类）：粗略的可注册域名用 */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'go'])

/** 粗略的可注册域名：一般取后两段；国家顶级域名前面是 co、com 这类时取后三段。IP、本机原样 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || !host.includes('.')) return host
  const labels = host.split('.')
  const tld = labels.at(-1) ?? ''
  const second = labels.at(-2) ?? ''
  const take = tld.length === 2 && SECOND_LEVEL.has(second) && labels.length >= 3 ? 3 : 2
  return labels.slice(-take).join('.')
}

/** 两个源同站：协议一样、可注册域名一样 */
export function sameSite(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.protocol === y.protocol && siteOf(x.hostname) === siteOf(y.hostname)
  } catch {
    return false
  }
}

const originOf = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * 预检：页面（登录框所在框架）的真实源 frameOrigin、条目的源 entryOrigin、条目记下的表单交去的源（可能没有）、
 * 预加载的报告 → 不能代填的原因，能就是 null
 */
export function preflight(input: {
  frameOrigin: string
  /** 卡片上的源（主框架的） */
  pageOrigin: string
  report: LoginReport | null
  /** 这个标签有开它的、或它开着的窗口 */
  related: boolean
}): SignInBlock | null {
  const { frameOrigin, pageOrigin, report } = input
  let secure = false
  try {
    const parsed = new URL(frameOrigin)
    secure =
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname))
  } catch {
    secure = false
  }
  if (!secure || frameOrigin !== pageOrigin || input.related) return 'insecure'
  if (!report || report.form === 'none') return 'no_form'
  if (report.form === 'ambiguous' || report.hint === 'invalid') return 'locator_invalid'
  if (!report.visible) return 'not_user_visible'
  if (report.method !== null && report.method.toLowerCase() === 'get') return 'insecure'
  if (report.action !== null) {
    const target = originOf(report.action)
    // javascript: 之类交不出去的不算交给别的站；交去的源必须同站
    if (target !== null && !sameSite(target, frameOrigin)) return 'insecure'
    if (target?.startsWith('http:') && frameOrigin.startsWith('https:')) {
      return 'insecure'
    }
  }
  return null
}

/** 两个小于 2^26 的素数：乘以小于 2^26 的底数后仍在双精度能精确表示的范围里 */
const P1 = 67108859
const P2 = 67108837

/** 找“那串密码”用的滚动哈希：长度、两组底数和目标值。不含密码本身 */
export interface SecretProbe {
  length: number
  b1: number
  b2: number
  h1: number
  h2: number
}

const hashOf = (text: string, base: number, mod: number): number => {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * base + text.charCodeAt(i)) % mod
  return h
}

/** random 给 [0, 1) 的随机数（主进程用 crypto 的） */
export function secretProbe(secret: string, random: () => number): SecretProbe {
  const b1 = 65_537 + Math.floor(random() * (P1 - 65_537))
  const b2 = 65_537 + Math.floor(random() * (P2 - 65_537))
  return { length: secret.length, b1, b2, h1: hashOf(secret, b1, P1), h2: hashOf(secret, b2, P2) }
}

const powMod = (base: number, exp: number, mod: number): number => {
  let result = 1
  for (let i = 0; i < exp; i++) result = (result * base) % mod
  return result
}

/** 返回一个判断函数：一段文字里有没有那串密码（按 UTF-16 码元滑窗） */
export function secretFinder(probe: SecretProbe): (text: string) => boolean {
  const { length, b1, b2, h1, h2 } = probe
  if (!Number.isInteger(length) || length <= 0) return () => false
  const top1 = powMod(b1, length - 1, P1)
  const top2 = powMod(b2, length - 1, P2)
  return (text) => {
    if (text.length < length) return false
    let x = 0
    let y = 0
    for (let i = 0; i < length; i++) {
      x = (x * b1 + text.charCodeAt(i)) % P1
      y = (y * b2 + text.charCodeAt(i)) % P2
    }
    if (x === h1 && y === h2) return true
    for (let i = length; i < text.length; i++) {
      const out = text.charCodeAt(i - length)
      const next = text.charCodeAt(i)
      x = (((((x - ((out * top1) % P1) + P1) % P1) * b1) % P1) + next) % P1
      y = (((((y - ((out * top2) % P2) + P2) % P2) * b2) % P2) + next) % P2
      if (x === h1 && y === h2) return true
    }
    return false
  }
}

/** 一个地址里（原样或解码后）有没有那串密码 */
export function urlHasSecret(url: string, has: (text: string) => boolean): boolean {
  if (has(url)) return true
  try {
    return has(decodeURIComponent(url.replace(/\+/g, ' ')))
  } catch {
    return false
  }
}

/** 关掉重开时开的地址：地址里带着密码的，去掉查询和片段；还是带着的，只开源 */
export function reopenUrl(url: string, has: (text: string) => boolean): string {
  if (!urlHasSecret(url, has)) return url
  try {
    const parsed = new URL(url)
    parsed.search = ''
    parsed.hash = ''
    const bare = parsed.toString()
    return urlHasSecret(bare, has) ? parsed.origin : bare
  } catch {
    return 'about:blank'
  }
}

/** 密码短于这么多字时，自检只查输入框的值（页面文字、属性里太容易碰巧有） */
export const SHORT_SECRET = 6
