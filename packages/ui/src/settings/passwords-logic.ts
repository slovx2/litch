// 设置页“已保存的密码”用到的判断：排序、搜索、来源怎么写。纯函数，单独测（test/passwords-logic.test.mjs）。
import type { BrowserSavedPassword } from '../side/browser/bridge.ts'
import { siteLabel } from './tools-logic.ts'

/** 来源标识前半段（浏览器）对应的产品名，不翻译 */
const BROWSERS: Record<string, string> = {
  chrome: 'Chrome',
  edge: 'Edge',
  brave: 'Brave',
  arc: 'Arc',
  chromium: 'Chromium',
  vivaldi: 'Vivaldi',
  firefox: 'Firefox',
}

/** 按站点排，同一个站点按用户名 */
export function sortPasswords(list: readonly BrowserSavedPassword[]): BrowserSavedPassword[] {
  return [...list].sort(
    (a, b) =>
      siteLabel(a.origin).localeCompare(siteLabel(b.origin)) ||
      a.username.localeCompare(b.username),
  )
}

/** 搜站点或用户名：不分大小写，空格隔开的几个词都要对得上 */
export function filterPasswords(
  list: readonly BrowserSavedPassword[],
  query: string,
): BrowserSavedPassword[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...list]
  return list.filter((one) => {
    const hay = `${one.origin} ${one.username}`.toLowerCase()
    return words.every((word) => hay.includes(word))
  })
}

/** `chrome:Default` 写成 `Chrome · Default`；认不出的照原样 */
export function sourceLabel(source: string): string {
  const at = source.indexOf(':')
  if (at <= 0) return source
  const name = BROWSERS[source.slice(0, at)]
  if (!name) return source
  const profile = source.slice(at + 1)
  return profile ? `${name} · ${profile}` : name
}
