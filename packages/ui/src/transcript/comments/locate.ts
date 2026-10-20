// 跳到评论的原文、闪一下：输入框上的片、原文上的记号、对话里的评论卡片、回答里的 [N] 都走这里。
// 原文在收起的过程里时先替它打开，等画出来再跳。
import { type ItemView, keys, type Replica, type TurnView } from '@litch/core'
import { setToggle } from '../state.ts'
import { findQuote, itemRoot, plainOf, rangeAt, squeeze, textNodes } from './text-range.ts'

type Store = Replica['store']

/** 闪一下用的高亮名字（样式里 ::highlight(litch-comment-flash)） */
const FLASH = 'litch-comment-flash'
const FLASH_MS = 1600

/** 发出去时太长被截掉的引用，结尾带着这一句 */
const TRUNCATED = '… (truncated)'

export interface CommentTarget {
  deviceId: string
  sessionId: string
  quote: string
  /** 知道原文在哪条回答里（还没发出去的评论）就给 */
  itemId?: string | undefined
  /** 知道在正文里的起止就给，对不上再按引用找 */
  start?: number | undefined
  end?: number | undefined
  raw?: string | undefined
  /** 按引用找时只看这一条（发出评论的那条用户消息）之前的：评论针对的是之前的回答 */
  before?: string | undefined
}

/** 这个会话里的回合，从早到晚 */
const turnsOf = (store: Store, deviceId: string, sessionId: string): TurnView[] =>
  (store.get<string[]>(keys.turnIds(deviceId, sessionId)) ?? []).flatMap((turnId) => {
    const turn = store.get<TurnView>(keys.turn(deviceId, sessionId, turnId))
    return turn ? [turn] : []
  })

const bare = (quote: string) =>
  quote.endsWith(TRUNCATED) ? quote.slice(0, -TRUNCATED.length) : quote

/**
 * 原文在哪条回答、哪个回合里。给了 itemId 先按它找回合；没给、或者对不上，就按引用在助手的话里找，有几处取最晚的那处。
 * 回答是 Markdown 原文，引用是画出来的字：比的时候记号和空白都不算；整段对不上再拿开头一截试
 */
export function findOrigin(
  store: Store,
  target: CommentTarget,
): { itemId: string; turnId: string } | null {
  const turns = turnsOf(store, target.deviceId, target.sessionId)
  if (target.itemId) {
    const turn = turns.find((each) => each.itemIds.includes(target.itemId ?? ''))
    if (turn) return { itemId: target.itemId, turnId: turn.id }
    // 标识对不上（重开之后会话重新读出来，标识换了写法）：往下按引用找
  }
  const wanted = squeeze(bare(target.raw || target.quote))
  if (!wanted) return null
  const before = target.before ?? ''
  const stop = before ? turns.findIndex((turn) => turn.itemIds.includes(before)) : -1
  const scope = stop >= 0 ? turns.slice(0, stop + 1) : turns
  for (const part of [wanted, wanted.slice(0, 30)]) {
    for (let at = scope.length - 1; at >= 0; at--) {
      const turn = scope[at]
      if (!turn) continue
      // 发出评论的那个回合里只看那条消息前面的
      const until = at === stop ? turn.itemIds.indexOf(before) : turn.itemIds.length
      for (let index = until - 1; index >= 0; index--) {
        const itemId = turn.itemIds[index] ?? ''
        const item = store.get<ItemView>(keys.item(target.deviceId, target.sessionId, itemId))
        if (item?.kind === 'agentMessage' && squeeze(item.text).includes(part)) {
          return { itemId, turnId: turn.id }
        }
      }
    }
  }
  return null
}

/** 那条回答正文里原文的那一段。位置对不上就按引用找，再找不到给 null */
export function originRange(root: Element, target: CommentTarget): Range | null {
  const nodes = textNodes(root)
  const plain = plainOf(nodes)
  const { start, end, raw } = target
  if (start !== undefined && end !== undefined && raw !== undefined) {
    if (plain.slice(start, end) === raw) return rangeAt(nodes, start, end)
    const moved = findQuote(plain, raw, start)
    if (moved) return rangeAt(nodes, moved[0], moved[1])
  }
  const found = findQuote(plain, bare(target.quote), start ?? 0)
  return found ? rangeAt(nodes, found[0], found[1]) : null
}

let flashTimer = 0

/** 让一段字闪一下 */
function flashRange(range: Range): void {
  const highlights = typeof CSS !== 'undefined' ? CSS.highlights : undefined
  if (!highlights) return
  highlights.set(FLASH, new Highlight(range))
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => highlights.delete(FLASH), FLASH_MS)
}

const smooth = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))

/**
 * 跳到原文、闪一下。原文在收起的过程里就先替它打开。找不到（回答不在这个会话里了）返回 false
 */
export async function revealOrigin(store: Store, target: CommentTarget): Promise<boolean> {
  const origin = findOrigin(store, target)
  if (!origin) return false
  const scope = document.querySelector('.main .tr') ?? document
  let root = itemRoot(scope, origin.itemId)
  if (!root) {
    setToggle(`${target.deviceId}:${target.sessionId}`, `p:${origin.turnId}`, true)
    for (let tries = 0; tries < 10 && !root; tries++) {
      await frame()
      root = itemRoot(scope, origin.itemId)
    }
  }
  if (!root) return false
  const range = originRange(root, target)
  const lead = range?.startContainer.parentElement ?? root
  lead.scrollIntoView({ block: 'center', behavior: smooth() })
  if (range) flashRange(range)
  else {
    root.setAttribute('data-flash', '')
    window.setTimeout(() => root.removeAttribute('data-flash'), FLASH_MS)
  }
  return true
}
