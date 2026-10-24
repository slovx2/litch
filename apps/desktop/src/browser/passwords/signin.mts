// “代理请你登录”的登记（request_sign_in）：代理把一个标签交给人登录，这里记着哪些标签在人手里、给界面的卡片
// 长什么样、人答了什么。卡片只给界面（浏览器面板、对话里的卡片、经设备转到手机上的那份），不给代理；
// 里面没有任何人输入的东西，也没有密码。
// 卡片醒目的是主进程取到的真实来源（随导航更新），代理填的站点名和原因只作附注。
// 卡片先让人选（stage: choose）：用密码库里这个源的某个账号由 Litch 代填（fill）、自己登录（self，转成
// manual，等人点“完成，交还”）、拒绝（cancel）。选了代填之后是 filling，代填完撤掉。
// 账号用这张卡片里随机的 ref 指，ref 背后的条目号只在这里，不出主进程。
// 定时任务的回合（taskId）卡片有过期时间，到点按 expired 结束。
// 代理不等了（回合打断、结束、断线）时卡片不悄悄消失：变成“代理已收回”，等人看到点“知道了”。
// 这一页没能安全地重新载入、标签被关掉时，卡片变成“标签已关掉”，不再指向哪个标签，同样等人点“知道了”。
// 不引 electron，单元测试在 test/passwords-signin.test.mts；真的交接（冻结、代填、清框）在 handover.mts。
import { randomBytes, randomUUID } from 'node:crypto'
import type { TabOwner } from '../model.mjs'

/** 卡片上的一个可代填的账号 */
export interface SignInAccount {
  /** 这张卡片里随机的不透明编号（不是条目号），答复按它指 */
  ref: string
  /** 完整用户名：桌面端界面显示；给手机的那份由核心只给 masked */
  username: string
  /** 打码的用户名（so•••@gmail.com） */
  masked: string
  /** 毫秒：最近一次在内置浏览器里填过；没填过是 null */
  lastUsed: number | null
}

/**
 * 预检不过、不能代填的原因（卡片上“用账号登录”置灰并写原因）：
 * no_form：页面上没有登录框；not_user_visible：登录框看不见（没大小、透明、在屏幕外、被别的东西盖着）；
 * locator_invalid：代理给的编号提示不在 Litch 认出的登录表单里，或者登录表单不止一个、认不出该填哪个；
 * insecure：不是 https（本机回环除外）、表单用 GET 交、交给别的站、这个标签有开它的或它开的窗口；
 * verification：上一次代填后网站要验证码或二次验证，这一次只能人自己登录；
 * unavailable：密码库这会儿用不了（钥匙串打不开）；
 * origin_changed：出卡片之后页面换到了别的源，卡片上的账号不是这个源的
 */
export type SignInBlock =
  | 'no_form'
  | 'not_user_visible'
  | 'locator_invalid'
  | 'insecure'
  | 'verification'
  | 'unavailable'
  | 'origin_changed'

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
  /**
   * waiting：等人登录；withdrawn：代理不等了，标签已重新载入，提醒人别再在这里输入；
   * closed：没能安全地重新载入，标签已关掉（交接期间输入的东西没有交给代理），卡片不再指向标签
   */
  state: 'waiting' | 'withdrawn' | 'closed'
  /**
   * waiting 时卡片在哪一步。choose：等人选（用账号登录 / 我自己登录 / 拒绝）；
   * manual：人选了自己登录，等人点“完成，交还”或“取消”；filling：Litch 正在代填，没有按钮
   */
  stage: 'choose' | 'manual' | 'filling'
  /** 密码库里和这个源完全一样的条目，按最近使用排；没有是空的 */
  accounts: SignInAccount[]
  /** 预检不过的原因；null 是能代填（accounts 为空时也是 null，界面按没有账号说） */
  fillBlocked: SignInBlock | null
  /** 定时任务的回合才有：哪个任务（卡片上出“以后直接用这个账号”的勾选） */
  taskId: string | null
  /** 毫秒，只有定时任务的回合有：到点没人答就按过期结束 */
  expiresAt: number | null
  /** 桌面端出的随机数：手机的答复要签上它（用一次作废） */
  nonce: string
  /** 毫秒 */
  at: number
}

/**
 * 人的回答。done：人登录完、交还了；cancel：拒绝 / 不登录了；dismiss：“代理已收回”“标签已关掉”的卡片看过了；
 * self：我自己登录（choose → manual）；{ fill, remember }：用卡片上 ref 那个账号代填，remember 是定时任务的
 * “以后直接用这个账号”（不是定时任务的回合忽略）
 */
export type SignInAnswer =
  | 'done'
  | 'cancel'
  | 'dismiss'
  | 'self'
  | { fill: string; remember: boolean }

/** 谁答的：桌面端界面，或者某台手机（验过签名的） */
export type SignInBy = 'desktop' | { phoneId: string }

/** 卡片怎么结束的（交给 handover.mts） */
export type SignInResolution =
  | { kind: 'done' }
  | { kind: 'cancel'; by: SignInBy }
  /** 用 entryId 那一条代填；entryId 只在主进程 */
  | { kind: 'fill'; ref: string; entryId: string; remember: boolean; by: SignInBy }
  /** 定时任务的回合，到点没人答 */
  | { kind: 'expired' }

/** begin 时给的一个账号：条目号只留在登记里 */
export interface SignInEntry {
  entryId: string
  username: string
  lastUsed: number | null
}

/** “代理已收回”“标签已关掉”的卡片没人点也只挂这么久 */
const WITHDRAWN_LIFE_MS = 10 * 60_000

/** 打码的用户名：@ 前留头两个字（不到三个字只留一个），其余换成 •••；没有 @ 的同样只留开头 */
export function maskUsername(username: string): string {
  const at = username.lastIndexOf('@')
  const local = at > 0 ? username.slice(0, at) : username
  const domain = at > 0 ? username.slice(at) : ''
  const chars = [...local]
  const keep = chars.length > 2 ? 2 : Math.min(1, chars.length)
  return `${chars.slice(0, keep).join('')}•••${domain}`
}

export interface SignIns {
  /** 交出一个标签：出卡片，等人答。同一个标签同时只能有一张在等 */
  begin(input: {
    owner: TabOwner
    tabId: string
    origin: string
    site: string
    reason: string
    /** 密码库里这个源的条目（已按最近使用排好）；不给是没有 */
    accounts?: SignInEntry[]
    fillBlocked?: SignInBlock | null
    taskId?: string | null
    /** 定时任务的回合：多久没人答就过期 */
    expiresInMs?: number | null
  }): { id: string; answered: Promise<SignInResolution> } | null
  /** 标签导航了：卡片上的来源跟着换 */
  setOrigin(id: string, origin: string): void
  /** 重新预检了：能不能代填跟着换 */
  setBlocked(id: string, block: SignInBlock | null): void
  /** 人答了（by 不给是桌面端）。回答没答到（已经没了、状态不对、ref 不在卡片上） */
  answer(id: string, answer: SignInAnswer, by?: SignInBy): boolean
  /** 现在的这张；没了是 null */
  get(id: string): SignInRequest | null
  /** 交接正常结束（含代填完）：撤掉卡片 */
  end(id: string): void
  /** 代理不等了：卡片变成“代理已收回”，留着等人看 */
  withdraw(id: string): void
  /**
   * 没能安全地重新载入、要关掉标签：这个标签原来的卡片撤掉，换一张“标签已关掉”的留着等人看
   * （随后的 tabGone 不撤它）
   */
  closed(input: {
    owner: TabOwner
    tabId: string
    origin: string
    site: string
    reason: string
  }): void
  /** 标签没了：它的卡片都撤掉（“标签已关掉”的除外） */
  tabGone(tabId: string): void
  list(): SignInRequest[]
  onChange(listener: (requests: SignInRequest[]) => void): () => void
}

interface Open {
  request: SignInRequest
  /** ref → 条目号 */
  entries: Map<string, string>
  settle(resolution: SignInResolution): void
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
  const open = new Map<string, Open>()
  const listeners = new Set<(requests: SignInRequest[]) => void>()
  const copy = (request: SignInRequest): SignInRequest => ({
    ...request,
    accounts: request.accounts.map((one) => ({ ...one })),
  })
  const list = () => [...open.values()].map((one) => copy(one.request))
  const changed = () => {
    const current = list()
    for (const listener of listeners) listener(current)
  }
  /** 收回、关掉的卡片到点自己撤 */
  const expire = (id: string, one: Open) =>
    schedule(() => {
      if (open.get(id) === one) {
        open.delete(id)
        changed()
      }
    }, WITHDRAWN_LIFE_MS)
  const waiting = (tabId: string) =>
    [...open.values()].some((one) => one.request.tabId === tabId && one.request.state === 'waiting')
  const card = (
    input: { owner: TabOwner; tabId: string; origin: string; site: string; reason: string },
    state: SignInRequest['state'],
  ): SignInRequest => ({
    id: randomUUID(),
    deviceId: input.owner.deviceId,
    threadId: input.owner.threadId,
    tabId: input.tabId,
    origin: input.origin,
    site: input.site,
    reason: input.reason,
    state,
    stage: 'choose',
    accounts: [],
    fillBlocked: null,
    taskId: null,
    expiresAt: null,
    nonce: randomBytes(16).toString('base64url'),
    at: now(),
  })

  return {
    begin(input) {
      if (waiting(input.tabId)) return null
      // 同一个标签上一张“代理已收回”的不用再留
      for (const [id, one] of open) if (one.request.tabId === input.tabId) open.delete(id)
      const request = card(input, 'waiting')
      const entries = new Map<string, string>()
      for (const entry of input.accounts ?? []) {
        const ref = `a${randomBytes(6).toString('hex')}`
        entries.set(ref, entry.entryId)
        request.accounts.push({
          ref,
          username: entry.username,
          masked: maskUsername(entry.username),
          lastUsed: entry.lastUsed,
        })
      }
      request.fillBlocked = input.fillBlocked ?? null
      request.taskId = input.taskId ?? null
      const life = request.taskId ? (input.expiresInMs ?? null) : null
      request.expiresAt = life === null ? null : request.at + life
      let settle: (resolution: SignInResolution) => void = () => {}
      const answered = new Promise<SignInResolution>((resolve) => {
        settle = resolve
      })
      const one: Open = { request, entries, settle }
      open.set(request.id, one)
      // 定时任务的回合：到点还在等人选就过期（人已经选了自己登录、正在代填的不算）
      if (life !== null) {
        schedule(() => {
          if (open.get(request.id) !== one) return
          if (request.state !== 'waiting' || request.stage !== 'choose') return
          open.delete(request.id)
          one.settle({ kind: 'expired' })
          changed()
        }, life)
      }
      changed()
      return { id: request.id, answered }
    },
    setOrigin(id, origin) {
      const one = open.get(id)
      if (!one || one.request.origin === origin) return
      one.request.origin = origin
      changed()
    },
    setBlocked(id, block) {
      const one = open.get(id)
      if (!one || one.request.fillBlocked === block) return
      one.request.fillBlocked = block
      changed()
    },
    answer(id, answer, by = 'desktop') {
      const one = open.get(id)
      if (!one) return false
      const { request } = one
      if (request.state !== 'waiting') {
        if (answer !== 'dismiss' || by !== 'desktop') return false
        open.delete(id)
        changed()
        return true
      }
      if (request.stage === 'filling' || answer === 'dismiss') return false
      // 手机只能代填或拒绝（网页在桌面端）
      if (by !== 'desktop' && (answer === 'self' || answer === 'done')) return false
      if (answer === 'self') {
        if (request.stage !== 'choose') return false
        request.stage = 'manual'
        changed()
        return true
      }
      if (answer === 'done' || answer === 'cancel') {
        open.delete(id)
        one.settle(answer === 'done' ? { kind: 'done' } : { kind: 'cancel', by })
        changed()
        return true
      }
      if (request.stage !== 'choose' || request.fillBlocked !== null) return false
      const entryId = one.entries.get(answer.fill)
      if (!entryId) return false
      // 卡片留着（filling，没有按钮），代填完由 handover.mts 撤掉
      request.stage = 'filling'
      one.settle({
        kind: 'fill',
        ref: answer.fill,
        entryId,
        remember: request.taskId !== null && answer.remember === true,
        by,
      })
      changed()
      return true
    },
    get(id) {
      const one = open.get(id)
      return one ? copy(one.request) : null
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
      expire(id, one)
    },
    closed(input) {
      for (const [id, one] of open) if (one.request.tabId === input.tabId) open.delete(id)
      const one: Open = { request: card(input, 'closed'), entries: new Map(), settle: () => {} }
      open.set(one.request.id, one)
      changed()
      expire(one.request.id, one)
    },
    tabGone(tabId) {
      let dropped = false
      for (const [id, one] of open) {
        if (one.request.tabId === tabId && one.request.state !== 'closed') {
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
