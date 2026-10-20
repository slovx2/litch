// 产品里的 CookieJar：内置浏览器共用的持久分区（PARTITION）的 session.cookies。
import { session } from 'electron'
import { PARTITION } from '../browser/electron-tab.mjs'
import type { CookieJar } from './cookies.mjs'

export function electronCookieJar(partition = PARTITION): CookieJar {
  const cookies = () => session.fromPartition(partition).cookies
  return {
    list: () => cookies().get({}),
    set: (details) => cookies().set(details),
    flush: () => cookies().flushStore(),
  }
}
