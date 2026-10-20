// “代理请你登录”的登记（request_sign_in）：代理把一个标签交给人登录，这里记着哪些标签在人手里、给界面的卡片
// 长什么样、人答了什么。卡片只给界面（浏览器面板），不给代理；里面没有任何人输入的东西。
// 卡片醒目的是主进程取到的真实来源（随导航更新），代理填的站点名和原因只作附注。
// 代理不等了（回合打断、结束、断线）时卡片不悄悄消失：变成“代理已收回”，等人看到点“知道了”。
// 不引 electron，单元测试在 test/passwords-signin.test.mts；真的交接（冻结、清框）在 handover.mts。
import { randomUUID } from 'node:crypto'
import type { TabOwner } from '../model.mjs'

/** 给界面的一张卡片 */
export interface SignInRequest {
  id: string
  /** 哪个会话的哪个标签 */
  deviceId: string
  threadId: string
  tabId: string
  /** 主进程取到的这个标签现在的来源（https://accounts.example.com），随导航更新；不是网页的是空的 */
  origin: string
  /** 代理说的要登录什么（没说就是页面的主机名），只作附注 */
  site: string
  /** 代理说的为什么要登录，只作附注 */
  reason: string
  /** waiting：等人登录；withdrawn：代理不等了，标签已重新载入，提醒人别再在这里输入 */
  state: 'waiting' | 'withdrawn'
  /** 毫秒 */
  at: number
}

/** done：人登录完、交还了；cancel：人不登录了；dismiss：“代理已收回”的卡片看过了 */
export type SignInAnswer = 'done' | 'cancel' | 'dismiss'

/** “代理已收回”的卡片没人点也只挂这么久 */
const WITHDRAWN_LIFE_MS = 10 * 60_000

export interface SignIns {
  /** 交出一个标签：出卡片，等人答。同一个标签同时只能有一张在等 */
  begin(input: {
    owner: TabOwner
    tabId: string
    origin: string
    site: string
    reason: string
  }): { id: string; answered: Promise<'done' | 'cancel'> } | null
  /** 标签导航了：卡片上的来源跟着换 */
  setOrigin(id: string, origin: string): void
  /** 人答了。回答没答到（已经没了、状态不对） */
  answer(id: string, answer: SignInAnswer): boolean
  /** 交接正常结束：撤掉卡片 */
  end(id: string): void
  /** 代理不等了：卡片变成“代理已收回”，留着等人看 */
  withdraw(id: string): void
  /** 标签没了：它的卡片都撤掉 */
  tabGone(tabId: string): void
  list(): SignInRequest[]
  onChange(listener: (requests: SignInRequest[]) => void): () => void
}

export function createSignIns(
  options: {
    now?: () => number
    /** 定时器，测试里换掉 */
    schedule?: (run: () => void, ms: number) => void
  } = {},
): SignIns {
  const now = options.now ?? Date.now
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => {
      setTimeout(run, ms).unref?.()
    })
  const open = new Map<
    string,
    { request: SignInRequest; settle(answer: 'done' | 'cancel'): void }
  >()
  const listeners = new Set<(requests: SignInRequest[]) => void>()
  const list = () => [...open.values()].map((one) => ({ ...one.request }))
  const changed = () => {
    const current = list()
    for (const listener of listeners) listener(current)
  }
  const waiting = (tabId: string) =>
    [...open.values()].some((one) => one.request.tabId === tabId && one.request.state === 'waiting')

  return {
    begin({ owner, tabId, origin, site, reason }) {
      if (waiting(tabId)) return null
      // 同一个标签上一张“代理已收回”的不用再留
      for (const [id, one] of open) if (one.request.tabId === tabId) open.delete(id)
      const id = randomUUID()
      let settle: (answer: 'done' | 'cancel') => void = () => {}
      const answered = new Promise<'done' | 'cancel'>((resolve) => {
        settle = resolve
      })
      open.set(id, {
        request: {
          id,
          deviceId: owner.deviceId,
          threadId: owner.threadId,
          tabId,
          origin,
          site,
          reason,
          state: 'waiting',
          at: now(),
        },
        settle,
      })
      changed()
      return { id, answered }
    },
    setOrigin(id, origin) {
      const one = open.get(id)
      if (!one || one.request.origin === origin) return
      one.request.origin = origin
      changed()
    },
    answer(id, answer) {
      const one = open.get(id)
      if (!one) return false
      if (one.request.state === 'withdrawn') {
        if (answer !== 'dismiss') return false
      } else if (answer === 'dismiss') return false
      open.delete(id)
      if (answer !== 'dismiss') one.settle(answer)
      changed()
      return true
    },
    end(id) {
      const one = open.get(id)
      if (one?.request.state !== 'waiting') return
      open.delete(id)
      changed()
    },
    withdraw(id) {
      const one = open.get(id)
      if (one?.request.state !== 'waiting') return
      one.request.state = 'withdrawn'
      changed()
      schedule(() => {
        if (open.get(id) === one) {
          open.delete(id)
          changed()
        }
      }, WITHDRAWN_LIFE_MS)
    },
    tabGone(tabId) {
      let dropped = false
      for (const [id, one] of open) {
        if (one.request.tabId === tabId) {
          open.delete(id)
          dropped = true
        }
      }
      if (dropped) changed()
    },
    list,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
