// “代理请你登录”的登记（request_sign_in）：代理把一个标签交给人登录，这里记着哪些标签在人手里、给界面的卡片
// 长什么样、人答了什么。卡片只给界面（浏览器面板），不给代理；里面没有任何人输入的东西。
// 不引 electron，单元测试在 test/passwords-signin.test.mts；真的交接（冻结、清密码框）在 handover.mts。
import { randomUUID } from 'node:crypto'
import type { TabOwner } from '../model.mjs'

/** 给界面的一张卡片 */
export interface SignInRequest {
  id: string
  /** 哪个会话的哪个标签 */
  deviceId: string
  threadId: string
  tabId: string
  /** 代理说的要登录什么（没说就是页面的主机名） */
  site: string
  /** 代理说的为什么要登录 */
  reason: string
  /** 毫秒 */
  at: number
}

/** done：人登录完、交还了；cancel：人不登录了 */
export type SignInAnswer = 'done' | 'cancel'

export interface SignIns {
  /** 交出一个标签：出卡片，等人答。同一个标签同时只能有一张 */
  begin(input: {
    owner: TabOwner
    tabId: string
    site: string
    reason: string
  }): { id: string; answered: Promise<SignInAnswer> } | null
  /** 人答了。回答没答到（已经没了） */
  answer(id: string, answer: SignInAnswer): boolean
  /** 不等了（回合打断、标签关了）：撤掉卡片，不答 */
  end(id: string): void
  /** 这个标签在不在人手里 */
  active(tabId: string): boolean
  list(): SignInRequest[]
  onChange(listener: (requests: SignInRequest[]) => void): () => void
}

export function createSignIns(options: { now?: () => number } = {}): SignIns {
  const now = options.now ?? Date.now
  const open = new Map<string, { request: SignInRequest; settle(answer: SignInAnswer): void }>()
  const listeners = new Set<(requests: SignInRequest[]) => void>()
  const list = () => [...open.values()].map((one) => one.request)
  const changed = () => {
    const current = list()
    for (const listener of listeners) listener(current)
  }
  const active = (tabId: string) => [...open.values()].some((one) => one.request.tabId === tabId)

  return {
    begin({ owner, tabId, site, reason }) {
      if (active(tabId)) return null
      const id = randomUUID()
      let settle: (answer: SignInAnswer) => void = () => {}
      const answered = new Promise<SignInAnswer>((resolve) => {
        settle = resolve
      })
      open.set(id, {
        request: {
          id,
          deviceId: owner.deviceId,
          threadId: owner.threadId,
          tabId,
          site,
          reason,
          at: now(),
        },
        settle,
      })
      changed()
      return { id, answered }
    },
    answer(id, answer) {
      const one = open.get(id)
      if (!one) return false
      open.delete(id)
      one.settle(answer)
      changed()
      return true
    },
    end(id) {
      if (open.delete(id)) changed()
    },
    active,
    list,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
