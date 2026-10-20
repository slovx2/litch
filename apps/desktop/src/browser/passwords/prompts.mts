// 登录之后提示保存（或更新）密码。预加载认出登录表单提交，把源、用户名、密码交上来；这里先比一下库里有没有、
// 一样不一样，加密之后只在内存里暂存；那个标签接着导航完成了（登录多半会跳页），才变成一条给人看的提示，
// 推给界面的浏览器面板。用户点保存才存，点“这个网站永不”记进名单；没人理就一直挂着，到点丢掉，从不自动保存。
// 提示只给界面，不给代理、不进工具结果。不引 electron，单元测试在 test/passwords-prompts.test.mts。
import { randomUUID } from 'node:crypto'
import type { TabInfo } from '../model.mjs'
import type { PasswordStore } from './store.mjs'

/** 给界面的一条提示：没有密码 */
export interface SavePrompt {
  id: string
  /** 哪个会话的哪个标签里登录的 */
  deviceId: string
  threadId: string
  tabId: string
  origin: string
  username: string
  /** save：库里没有这个用户名；update：有，但密码不一样 */
  kind: 'save' | 'update'
  /** 毫秒 */
  at: number
}

export type PromptAnswer = 'save' | 'dismiss' | 'never'

export interface SavePrompts {
  /** 预加载报上来的一次登录提交（源是主进程从 senderFrame 取的、规范化过的）。回暂存了没有 */
  capture(
    contentsId: number,
    tab: TabInfo,
    origin: string,
    username: string,
    password: string,
  ): boolean
  /** 这个标签的主框架导航了；inPage 是同一页里换地址（单页应用），算导航完成 */
  navigated(contentsId: number, inPage: boolean): void
  /** 这个标签停止加载了 */
  loaded(contentsId: number): void
  /** 标签没了：丢掉还没变成提示的那一份（已经出了的提示留着） */
  tabGone(contentsId: number): void
  list(): SavePrompt[]
  /** 用户答了一条。回答没答到（已经没了） */
  answer(id: string, answer: PromptAnswer): boolean
  /** 提示列表变了 */
  onChange(listener: (prompts: SavePrompt[]) => void): () => void
}

/** 提交之后这么久内没导航完成，就当登录没成，丢掉 */
const CAPTURE_LIFE_MS = 60_000
/** 提示没人理，这么久之后丢掉 */
const PROMPT_LIFE_MS = 30 * 60_000
const USERNAME_MAX = 1024
const PASSWORD_MAX = 4096

interface Pending {
  tab: TabInfo
  origin: string
  username: string
  sealed: string
  kind: 'save' | 'update'
  at: number
  navigated: boolean
}

/** 保存的时候记的来源 */
export const SAVED_SOURCE = 'litch'

export function createSavePrompts(options: {
  store: Pick<PasswordStore, 'compare' | 'seal' | 'putSealed' | 'isNever' | 'addNever'>
  now?: () => number
}): SavePrompts {
  const { store } = options
  const now = options.now ?? Date.now
  const pending = new Map<number, Pending>()
  /** 提示编号 → 提示和它暂存的密文 */
  const prompts = new Map<string, { prompt: SavePrompt; sealed: string }>()
  const listeners = new Set<(prompts: SavePrompt[]) => void>()

  const live = (): SavePrompt[] => {
    const cutoff = now() - PROMPT_LIFE_MS
    for (const [id, one] of prompts) if (one.prompt.at < cutoff) prompts.delete(id)
    return [...prompts.values()].map((one) => one.prompt)
  }
  const changed = () => {
    const list = live()
    for (const listener of listeners) listener(list)
  }
  const fresh = (contentsId: number): Pending | null => {
    const one = pending.get(contentsId)
    if (!one) return null
    if (now() - one.at > CAPTURE_LIFE_MS) {
      pending.delete(contentsId)
      return null
    }
    return one
  }
  const publish = (contentsId: number, one: Pending) => {
    pending.delete(contentsId)
    // 同一个网站同一个用户名的旧提示换成新的
    for (const [id, old] of prompts) {
      if (old.prompt.origin === one.origin && old.prompt.username === one.username)
        prompts.delete(id)
    }
    const id = randomUUID()
    prompts.set(id, {
      sealed: one.sealed,
      prompt: {
        id,
        deviceId: one.tab.owner.deviceId,
        threadId: one.tab.owner.threadId,
        tabId: one.tab.id,
        origin: one.origin,
        username: one.username,
        kind: one.kind,
        at: now(),
      },
    })
    changed()
  }

  return {
    capture(contentsId, tab, origin, username, password) {
      if (password === '' || password.length > PASSWORD_MAX || username.length > USERNAME_MAX)
        return false
      if (store.isNever(origin)) return false
      const match = store.compare(origin, username, password)
      if (match === 'same') {
        pending.delete(contentsId)
        return false
      }
      const sealed = store.seal(password)
      if (!sealed) return false
      pending.set(contentsId, {
        tab,
        origin,
        username,
        sealed,
        kind: match === 'different' ? 'update' : 'save',
        at: now(),
        navigated: false,
      })
      return true
    },
    navigated(contentsId, inPage) {
      const one = fresh(contentsId)
      if (!one) return
      if (inPage) publish(contentsId, one)
      else one.navigated = true
    },
    loaded(contentsId) {
      const one = fresh(contentsId)
      if (one?.navigated) publish(contentsId, one)
    },
    tabGone(contentsId) {
      pending.delete(contentsId)
    },
    list: live,
    answer(id, answer) {
      const one = prompts.get(id)
      if (!one) return false
      prompts.delete(id)
      const { origin, username } = one.prompt
      if (answer === 'save') {
        store.putSealed({ origin, username, sealed: one.sealed, source: SAVED_SOURCE })
      } else if (answer === 'never') {
        store.addNever(origin)
        // 同一个网站别的提示也不要了
        for (const [other, rest] of prompts)
          if (rest.prompt.origin === origin) prompts.delete(other)
      }
      changed()
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
