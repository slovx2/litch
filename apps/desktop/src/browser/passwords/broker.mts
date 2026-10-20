// 自动填充在主进程这一头的判断：谁能拿到候选、什么时候才把密码送出去。不引 electron，
// 外面（autofill.mts）把 senderFrame 包成 FrameRef 交进来，单元测试用假的（test/passwords-autofill.test.mts）。
//
// 规矩：
// - 只认登记过的标签（用户的、代理的都算）。源只看主进程从 senderFrame 取的真实源，预加载的消息里不带源；
//   跨源子框架按它自己的源。非 https 不填，本机回环的 http 除外（origin.mts 的 fillableOrigin）。
// - 候选只有用户名。密码只在点选之后解开那一条、只送给发起的那一个框架，送之前再核一遍框架还在、源没变。
// - 用户的标签：候选是主进程的原生菜单（autofill.mts），点选在菜单里。
// - 代理的标签：代理看不到原生菜单，候选由预加载画在网页里（封闭的影子树，只有用户名），代理用 click 点中一条，
//   预加载把“点的是第几条”报回来。主进程只认它先前给这个框架的那一份候选（inline），用一次就作废。
import { fillableOrigin } from './origin.mjs'
import type { PasswordStore } from './store.mjs'

/** 主进程送进框架的那一条：只在点选之后 */
export interface FillMessage {
  username: string
  password: string
}

/** 发消息来的那个框架（主进程从 IPC 事件的 senderFrame 包出来的） */
export interface FrameRef {
  /** 所在 webContents 的编号 */
  contentsId: number
  /** 这个框架在主进程里的标识（同一个框架每次一样），以 `<contentsId>:` 开头 */
  key: string
  /** 主进程看到的这个框架现在的源 */
  origin(): string
  /** 框架还在、没被导航换掉 */
  alive(): boolean
  /** 送进这个框架（只有它的预加载收得到） */
  send(message: FillMessage): void
}

export interface AutofillOffer {
  /** 规范化过的源，点选时原样交回来核对 */
  origin: string
  usernames: string[]
  /** 和 usernames 一一对应，只在主进程里用 */
  ids: string[]
}

export type AutofillTabKind = 'user' | 'agent'

export interface AutofillBroker {
  /** 这个框架能拿到的候选；不该有的回 null */
  offerFor(frame: FrameRef): AutofillOffer | null
  /** 点选了 offer 里的第 index 条：核对之后填进去。回填没填 */
  fill(frame: FrameRef, offer: AutofillOffer, index: number): boolean
  /** 代理的标签：把候选交给预加载画在网页里，记下这一份。回给预加载的用户名；不该给的回 null */
  offerInline(frame: FrameRef): string[] | null
  /** 代理的标签：网页里的候选被点中了第 index 条。只认先前给这个框架的那一份，用一次就作废 */
  pickInline(frame: FrameRef, index: number): boolean
  /** 标签没了：丢掉它那些框架的候选 */
  forgetTab(contentsId: number): void
}

export function createAutofillBroker(options: {
  store: Pick<PasswordStore, 'candidates' | 'reveal'>
  /** 这个 webContents 是哪种标签；没登记过是 null */
  kindOf(contentsId: number): AutofillTabKind | null
}): AutofillBroker {
  /** 代理标签里画出去的候选：框架标识 → 那一份 */
  const inline = new Map<string, AutofillOffer>()

  const originOf = (frame: FrameRef): string | null => {
    if (!options.kindOf(frame.contentsId) || !frame.alive()) return null
    return fillableOrigin(frame.origin())
  }
  const offerFor = (frame: FrameRef): AutofillOffer | null => {
    const origin = originOf(frame)
    if (!origin) return null
    const candidates = options.store.candidates(origin)
    if (candidates.length === 0) return null
    return {
      origin,
      usernames: candidates.map((one) => one.username),
      ids: candidates.map((one) => one.id),
    }
  }
  const fill = (frame: FrameRef, offer: AutofillOffer, index: number): boolean => {
    const id = offer.ids[index]
    if (id === undefined) return false
    // 选的这会儿框架可能已经跳走了：源变了就不填
    if (originOf(frame) !== offer.origin) return false
    const secret = options.store.reveal(id, offer.origin)
    if (!secret) return false
    frame.send({ username: secret.username, password: secret.password })
    return true
  }
  return {
    offerFor,
    fill,
    offerInline(frame) {
      if (options.kindOf(frame.contentsId) !== 'agent') return null
      const offer = offerFor(frame)
      if (!offer) {
        inline.delete(frame.key)
        return null
      }
      inline.set(frame.key, offer)
      return offer.usernames
    },
    pickInline(frame, index) {
      const offer = inline.get(frame.key)
      inline.delete(frame.key)
      if (!offer || options.kindOf(frame.contentsId) !== 'agent') return false
      return fill(frame, offer, index)
    },
    forgetTab(contentsId) {
      for (const key of [...inline.keys()]) {
        if (key.startsWith(`${contentsId}:`)) inline.delete(key)
      }
    },
  }
}
