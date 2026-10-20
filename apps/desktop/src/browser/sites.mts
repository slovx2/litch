// 按来源审批的决定记在哪：
//   一直允许（always）：存在用户数据目录的 browser/sites.json，所有会话、所有设备都算；设置页能列出、删除
//   本会话（session）：内存里，按“设备 + 会话”记，应用退出就没了
//   这一次（once）、拒绝（decline）：内存里，按“设备 + 会话 + 回合”记，回合结束清掉
// “这一次”算到回合结束：模型打开一个网站之后总要接着读、点，每一步都问一遍没法用（官方也有按回合的缓存）。
// 拒绝也只记到回合结束，免得同一回合里模型一试再试、卡片一张接一张；下一个回合再问。
// 信任所有网站（trustAll）：开着时一律不问，只有黑名单里的（主机名本身和它的子域名）一律不许开；
// 关着时黑名单不起作用、照常问。这两样和“一直允许”存在同一个文件里，所有会话、所有设备都算。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostMatches, parseUrl } from './url.mjs'

/** blocked：信任所有网站时撞上了黑名单 */
export type SiteVerdict = 'allow' | 'decline' | 'blocked'

/** 设置页里一条“一直允许”的记录 */
export interface SavedSite {
  origin: string
  /** 什么时候允许的，毫秒 */
  at: number
}

/** 信任所有网站的开关和黑名单（设置页用） */
export interface SitePolicy {
  trustAll: boolean
  /** 黑名单里的主机名，排好序 */
  blocked: string[]
}

interface SitesFile {
  version: 1
  sites: SavedSite[]
  trustAll: boolean
  blocked: string[]
}

export interface SiteBook {
  /** 现在对这个来源怎么定；还没定是 undefined */
  verdict(session: string, turn: string, origin: string): SiteVerdict | undefined
  allowOnce(session: string, turn: string, origin: string): void
  allowSession(session: string, origin: string): void
  allowAlways(origin: string): void
  decline(session: string, turn: string, origin: string): void
  /** 回合结束：清掉这一回合的“这一次”和拒绝 */
  turnEnded(session: string, turn: string): void
  /** 一直允许的那些（设置页用） */
  saved(): SavedSite[]
  /** 删掉一条一直允许的；origin 不给就全删。回删掉了几条 */
  forget(origin?: string): number
  policy(): SitePolicy
  setTrustAll(on: boolean): void
  /** 加进黑名单。host 要先用 url.mts 的 blockedHostOf 认过 */
  block(host: string): void
  /** 从黑名单里去掉一项；host 不给就全去掉。回去掉了几项 */
  unblock(host?: string): number
}

/** 会话的键：设备加会话 */
export const sessionKey = (deviceId: string, threadId: string): string =>
  `${deviceId}\u0000${threadId}`

/** file：存“一直允许”的文件；null 只放内存（测试用） */
export function createSiteBook(file: string | null): SiteBook {
  let always = new Map<string, number>()
  let trustAll = false
  let blocked = new Set<string>()
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SitesFile>
      for (const site of parsed.sites ?? []) {
        if (typeof site?.origin === 'string' && typeof site.at === 'number') {
          always.set(site.origin, site.at)
        }
      }
      trustAll = parsed.trustAll === true
      for (const host of parsed.blocked ?? []) if (typeof host === 'string') blocked.add(host)
    } catch {
      // 没有或者坏了：当作一条都没有
      always = new Map()
      trustAll = false
      blocked = new Set()
    }
  }
  const sessions = new Map<string, Set<string>>()
  /** 键是“会话 + 回合” */
  const turns = new Map<string, Map<string, SiteVerdict>>()
  const turnKey = (session: string, turn: string) => `${session}\u0000${turn}`

  const save = () => {
    if (!file) return
    const body: SitesFile = {
      version: 1,
      sites: [...always].map(([origin, at]) => ({ origin, at })),
      trustAll,
      blocked: [...blocked].sort(),
    }
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再改名，写到一半退出不会留下坏文件
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }
  const inTurn = (session: string, turn: string) => {
    const key = turnKey(session, turn)
    let map = turns.get(key)
    if (!map) turns.set(key, (map = new Map()))
    return map
  }

  return {
    verdict(session, turn, origin) {
      if (trustAll) {
        const host = parseUrl(origin)?.hostname ?? ''
        return [...blocked].some((one) => hostMatches(host, one)) ? 'blocked' : 'allow'
      }
      const once = turns.get(turnKey(session, turn))?.get(origin)
      if (once) return once
      if (sessions.get(session)?.has(origin)) return 'allow'
      if (always.has(origin)) return 'allow'
      return undefined
    },
    allowOnce: (session, turn, origin) => void inTurn(session, turn).set(origin, 'allow'),
    decline: (session, turn, origin) => void inTurn(session, turn).set(origin, 'decline'),
    allowSession(session, origin) {
      let set = sessions.get(session)
      if (!set) sessions.set(session, (set = new Set()))
      set.add(origin)
    },
    allowAlways(origin) {
      always.set(origin, Date.now())
      save()
    },
    turnEnded: (session, turn) => void turns.delete(turnKey(session, turn)),
    saved: () => [...always].map(([origin, at]) => ({ origin, at })).sort((a, b) => b.at - a.at),
    forget(origin) {
      const before = always.size
      if (origin === undefined) always.clear()
      else always.delete(origin)
      const removed = before - always.size
      if (removed > 0) save()
      return removed
    },
    policy: () => ({ trustAll, blocked: [...blocked].sort() }),
    setTrustAll(on) {
      if (trustAll === on) return
      trustAll = on
      save()
    },
    block(host) {
      if (blocked.has(host)) return
      blocked.add(host)
      save()
    },
    unblock(host) {
      const before = blocked.size
      if (host === undefined) blocked.clear()
      else blocked.delete(host)
      const removed = before - blocked.size
      if (removed > 0) save()
      return removed
    },
  }
}

/** 存“一直允许”的文件放在用户数据目录的哪里 */
export const sitesFile = (userData: string): string => join(userData, 'browser', 'sites.json')
