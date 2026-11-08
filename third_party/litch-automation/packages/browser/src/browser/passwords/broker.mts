// 自动填充在主进程这一头的判断：谁能拿到候选、什么时候才把密码送出去。不引 electron，
// 外面（autofill.mts）把 senderFrame 包成 FrameRef 交进来，单元测试用假的（test/passwords-autofill.test.mts）。
//
// 规矩：
// - 只有人手里的标签能填：用户自己开的，和代理交给人登录、还没交还的（request_sign_in）。代理自己在用的标签
//   不出候选、不填，代理要登录就交给人。
// - 源只看主进程从 senderFrame 取的真实源，预加载的消息里不带源；跨源子框架按它自己的源。
//   非 https 不填，本机回环的 http 除外（origin.mts 的 fillableOrigin）。
// - 候选只有用户名，是主进程的原生菜单（autofill.mts），点选在菜单里。密码只在点选之后解开那一条、
//   只送给发起的那一个框架，送之前再核一遍框架还在、源没变、标签还在人手里。
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
}

export function createAutofillBroker(options: {
  store: Pick<PasswordStore, 'candidates' | 'reveal'>
  /** 这个 webContents 现在算哪种标签（交给人登录的代理标签算 user）；没登记过是 null */
  kindOf(contentsId: number): AutofillTabKind | null
}): AutofillBroker {
  /** 只有人手里的标签能填：代理的标签不给候选 */
  const originOf = (frame: FrameRef): string | null => {
    if (options.kindOf(frame.contentsId) !== 'user' || !frame.alive()) return null
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
    // 选的这会儿框架可能已经跳走了、标签可能已经交还给代理了：源变了、不在人手里就不填
    if (originOf(frame) !== offer.origin) return false
    const secret = options.store.reveal(id, offer.origin)
    if (!secret) return false
    frame.send({ username: secret.username, password: secret.password })
    return true
  }
  return { offerFor, fill }
}
