// 登录之后提示保存（或更新）密码。预加载认出登录表单提交，把用户名、密码交上来（源是主进程从 senderFrame 取的）；
// 这里先比一下库里有没有、一样不一样，加密之后只在内存里暂存；提交的那个框架（或整个标签）接着导航完成了
// （登录多半会跳页，只在子框架里登录的就看那个子框架），才变成一条给人看的提示，推给界面的浏览器面板。
// 用户点保存才存，点“这个网站永不”记进名单；没人理就挂着，标签关了一起丢，最长挂 30 分钟，从不自动保存。
// 系统钥匙串不可用时存不了，也出一条提示告诉人为什么（kind 是 unavailable，只能关掉）。
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
  /** save：库里没有这个用户名；update：有，但密码不一样；unavailable：系统钥匙串不可用，存不了 */
  kind: 'save' | 'update' | 'unavailable'
  /** 毫秒 */
  at: number
}

export type PromptAnswer = 'save' | 'dismiss' | 'never'

/** 预加载报上来的一次登录提交 */
export interface CapturedLogin {
  /** 主进程从 senderFrame 取的、规范化过的源 */
  origin: string
  /** 提交的框架（主进程里的 frameTreeNodeId，同一个框架导航前后不变）；主框架是 null */
  frame: number | null
  /** 可能是空的（两步登录的第二页、改密码表单常常没有看得见的用户名框） */
  username: string
  /** 新密码（改密码表单里是新的那个） */
  password: string
  /** 改密码表单里的当前密码：用户名是空的时候拿它在库里找是哪一条 */
  current?: string
}

/** 一次导航：frame 是导航的框架，主框架是 null；inPage 是同一页里换地址（单页应用） */
export interface FrameNavigation {
  frame: number | null
  inPage: boolean
}

export interface SavePrompts {
  /** 一次登录提交。回暂存了没有 */
  capture(contentsId: number, tab: TabInfo, login: CapturedLogin): boolean
  /** 两步登录的第一步（只有用户名的表单提交了）：记下用户名，第二步没有用户名框时用 */
  step(contentsId: number, origin: string, username: string): void
  /** 这个标签里有框架导航了 */
  navigated(contentsId: number, navigation: FrameNavigation): void
  /** 这个标签停止加载了 */
  loaded(contentsId: number): void
  /** 标签没了：暂存的、记下的用户名、已经出了的提示一起丢 */
  tabGone(contentsId: number): void
  list(): SavePrompt[]
  /**
   * 用户答了一条。回答没答到（已经没了、钥匙串不可用的那种只能关掉）。
   * 写库失败就抛（message 是给人看的说明），提示留着，可以再点
   */
  answer(id: string, answer: PromptAnswer): boolean
  /** 提示列表变了 */
  onChange(listener: (prompts: SavePrompt[]) => void): () => void
}

/** 提交之后这么久内没导航完成，就当登录没成，丢掉 */
const CAPTURE_LIFE_MS = 60_000
/** 两步登录第一步的用户名记这么久 */
const STEP_LIFE_MS = 5 * 60_000
/** 提示没人理，这么久之后丢掉 */
const PROMPT_LIFE_MS = 30 * 60_000
/** 一个标签最多挂几条提示、所有标签加起来最多几条：多出来的丢最旧的 */
const MAX_PER_TAB = 3
const MAX_TOTAL = 20
const USERNAME_MAX = 1024
const PASSWORD_MAX = 4096

interface Pending {
  tab: TabInfo
  origin: string
  frame: number | null
  username: string
  /** 钥匙串不可用时是 null */
  sealed: string | null
  kind: SavePrompt['kind']
  at: number
  navigated: boolean
}

interface Shown {
  contentsId: number
  prompt: SavePrompt
  sealed: string | null
}

/** 保存的时候记的来源 */
export const SAVED_SOURCE = 'litch'

/** 定时器：到点跑一次，回取消的函数。测试里换成手动的 */
export type Schedule = (run: () => void, ms: number) => () => void

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createSavePrompts(options: {
  store: Pick<
    PasswordStore,
    'compare' | 'usernameFor' | 'seal' | 'putSealed' | 'isNever' | 'addNever'
  >
  now?: () => number
  schedule?: Schedule
}): SavePrompts {
  const { store } = options
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? realSchedule
  const pending = new Map<number, Pending>()
  const steps = new Map<number, { origin: string; username: string; at: number }>()
  /** 提示编号 → 提示和它暂存的密文 */
  const prompts = new Map<string, Shown>()
  const listeners = new Set<(prompts: SavePrompt[]) => void>()

  const list = (): SavePrompt[] => [...prompts.values()].map((one) => one.prompt)
  const changed = () => {
    const current = list()
    for (const listener of listeners) listener(current)
  }

  // 到点清理：暂存的、记下的用户名、提示，各按各的时限；只在最早要过期的那一刻醒一次
  let cancel: (() => void) | null = null
  let armedAt = Number.POSITIVE_INFINITY
  const earliest = () => {
    let next = Number.POSITIVE_INFINITY
    for (const one of pending.values()) next = Math.min(next, one.at + CAPTURE_LIFE_MS)
    for (const one of steps.values()) next = Math.min(next, one.at + STEP_LIFE_MS)
    for (const one of prompts.values()) next = Math.min(next, one.prompt.at + PROMPT_LIFE_MS)
    return next
  }
  const arm = () => {
    const next = earliest()
    if (next === armedAt) return
    cancel?.()
    cancel = null
    armedAt = next
    if (next === Number.POSITIVE_INFINITY) return
    cancel = schedule(sweep, Math.max(0, next - now()))
  }
  function sweep() {
    cancel = null
    armedAt = Number.POSITIVE_INFINITY
    const at = now()
    for (const [id, one] of pending) if (at - one.at >= CAPTURE_LIFE_MS) pending.delete(id)
    for (const [id, one] of steps) if (at - one.at >= STEP_LIFE_MS) steps.delete(id)
    let dropped = false
    for (const [id, one] of prompts) {
      if (at - one.prompt.at >= PROMPT_LIFE_MS) {
        prompts.delete(id)
        dropped = true
      }
    }
    if (dropped) changed()
    arm()
  }

  const fresh = (contentsId: number): Pending | null => {
    const one = pending.get(contentsId)
    if (!one) return null
    if (now() - one.at >= CAPTURE_LIFE_MS) {
      pending.delete(contentsId)
      return null
    }
    return one
  }
  /** 多出来的丢最旧的：先按标签，再按全部 */
  const trim = (contentsId: number) => {
    const oldestFirst = [...prompts.entries()].sort((a, b) => a[1].prompt.at - b[1].prompt.at)
    let mine = oldestFirst.filter(([, one]) => one.contentsId === contentsId).length
    for (const [id, one] of oldestFirst) {
      if (mine <= MAX_PER_TAB) break
      if (one.contentsId !== contentsId) continue
      prompts.delete(id)
      mine--
    }
    for (const [id] of oldestFirst) {
      if (prompts.size <= MAX_TOTAL) break
      prompts.delete(id)
    }
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
      contentsId,
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
    trim(contentsId)
    changed()
    arm()
  }
  /** 用户名是空的：先看两步登录第一步记下的，再拿改密码表单里的当前密码在库里找 */
  const usernameOf = (contentsId: number, login: CapturedLogin): string => {
    if (login.username !== '') return login.username
    const step = steps.get(contentsId)
    if (step && step.origin === login.origin && now() - step.at < STEP_LIFE_MS) return step.username
    if (login.current) return store.usernameFor(login.origin, login.current) ?? ''
    return ''
  }

  return {
    capture(contentsId, tab, login) {
      const { origin, password } = login
      if (password === '' || password.length > PASSWORD_MAX) return false
      const username = usernameOf(contentsId, login)
      // 没有用户名的不提示：存下来也填不对
      if (username === '' || username.length > USERNAME_MAX) return false
      if (store.isNever(origin)) return false
      const match = store.compare(origin, username, password)
      if (match === 'same') {
        pending.delete(contentsId)
        return false
      }
      const sealed = store.seal(password)
      pending.set(contentsId, {
        tab,
        origin,
        frame: login.frame,
        username,
        sealed,
        kind: sealed === null ? 'unavailable' : match === 'different' ? 'update' : 'save',
        at: now(),
        navigated: false,
      })
      arm()
      return true
    },
    step(contentsId, origin, username) {
      if (username === '' || username.length > USERNAME_MAX) return
      steps.set(contentsId, { origin, username, at: now() })
      arm()
    },
    navigated(contentsId, navigation) {
      const one = fresh(contentsId)
      if (!one) return
      // 主框架导航了，或者提交的那个子框架自己导航了
      if (navigation.frame !== null && navigation.frame !== one.frame) return
      if (navigation.inPage) publish(contentsId, one)
      else one.navigated = true
    },
    loaded(contentsId) {
      const one = fresh(contentsId)
      if (one?.navigated) publish(contentsId, one)
    },
    tabGone(contentsId) {
      pending.delete(contentsId)
      steps.delete(contentsId)
      let dropped = false
      for (const [id, one] of prompts) {
        if (one.contentsId === contentsId) {
          prompts.delete(id)
          dropped = true
        }
      }
      if (dropped) changed()
      arm()
    },
    list,
    answer(id, answer) {
      const one = prompts.get(id)
      if (!one) return false
      const { origin, username, kind } = one.prompt
      if (answer === 'save') {
        if (kind === 'unavailable' || one.sealed === null) return false
        // 先写库：写不进去就抛，提示留着
        store.putSealed({ origin, username, sealed: one.sealed, source: SAVED_SOURCE })
      } else if (answer === 'never') {
        store.addNever(origin)
      }
      prompts.delete(id)
      if (answer === 'never') {
        // 同一个网站别的提示也不要了
        for (const [other, rest] of prompts)
          if (rest.prompt.origin === origin) prompts.delete(other)
      }
      changed()
      arm()
      return true
    },
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
