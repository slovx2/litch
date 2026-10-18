// 内置浏览器里的网址：地址栏里打的字怎么变成网址、哪些地址算本机（不用审批）、哪些协议能开。
// 纯函数，不碰 Electron，单元测试直接测（test/browser-url.test.mts）。

/** 空白页。新开的标签先是它 */
export const BLANK = 'about:blank'

/** 地址栏里打的不是网址时，拿去搜索。选了不跟踪的那一家 */
const SEARCH = 'https://duckduckgo.com/?q='

/** 本机的主机名：localhost、*.localhost、127.0.0.0/8、::1 */
export function isLocalHost(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (name === 'localhost' || name.endsWith('.localhost')) return true
  if (name === '::1' || name === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
}

/** 解析一个网址；解析不了是 null */
export function parseUrl(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** 能在内置浏览器里开的：http、https，和空白页 */
export function isOpenable(url: string): boolean {
  if (url === BLANK) return true
  const parsed = parseUrl(url)
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
}

/** 网址的来源（协议、主机、端口）。不是 http、https 的是 null */
export function originOf(url: string): string | null {
  const parsed = parseUrl(url)
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null
  return parsed.origin
}

/** 这个地址要不要审批：本机地址和空白页不用 */
export function needsApproval(url: string): boolean {
  if (url === BLANK || url === '') return false
  const parsed = parseUrl(url)
  if (!parsed) return true
  return !isLocalHost(parsed.hostname)
}

/**
 * 把人或模型给的一段字变成网址。已经带了协议的原样（能不能开另说）；
 * 像主机名的补上协议（本机地址补 http，别的补 https）；allowSearch 时别的拿去搜索，不然是 null。
 */
export function toAddress(input: string, allowSearch: boolean): string | null {
  const text = input.trim()
  if (text === '') return null
  if (text === BLANK) return BLANK
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text)) {
    return parseUrl(text) ? text : null
  }
  if (!/\s/.test(text)) {
    const host = text.split(/[/?#]/)[0] ?? ''
    const bare = host.replace(/:\d+$/, '')
    const looksLikeHost =
      bare.includes('.') ||
      isLocalHost(bare) ||
      /^\[[0-9a-f:]+\]$/i.test(bare) ||
      /:\d+$/.test(host)
    if (looksLikeHost) {
      const scheme = isLocalHost(bare) || /^\d+\.\d+\.\d+\.\d+$/.test(bare) ? 'http' : 'https'
      const url = parseUrl(`${scheme}://${text}`)
      if (url) return url.toString()
    }
  }
  return allowSearch ? `${SEARCH}${encodeURIComponent(text)}` : null
}
