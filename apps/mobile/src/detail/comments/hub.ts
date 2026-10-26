// 一个会话详情页里评论这件事的中枢：对话区的单元格、长按菜单、输入框上的评论片和几个浮层都经它说话。
// 详情页建一个、经上下文给下去（context.tsx）。上下文的值一直是同一个对象，单元格不会因为它重画；
// 会变的状态（在选字的是哪条回答、弹出的是哪条评论、要滚到哪一行、哪一行在闪）放在它自己身上，用的地方订阅。
// 选字回复：长按菜单里“选择文字”让那条回答能自由选字（selecting），选中后系统菜单里多一个“回复”，
// 点了先退出选字、弹出写评论的对话框（输入框拿着焦点），“加上”后作为评论片加到输入框上面
// （照桌面端选字后的“评论”：写在对话框里，加上以后不另外抢输入框的焦点；发出去拼成 <litch-comments>）。
import {
  MAX_COMMENTS,
  type ParsedComment,
  type ParsedComments,
  parseComments,
  type UserMessageItem,
} from '@litch/core'
import type { SessionStore } from '../../core/session-store'
import { addDraftComment, loadDraftComments } from '../composer/drafts'
import { findQuote, type QuoteTarget } from './refs'

/** 弹出来看的一条评论：发出去的那些（卡片、回答里的 [N]） */
export interface ShownComment {
  comment: ParsedComment
  /** 带着这条评论的用户消息在哪一回合（找原文时从这里往前找） */
  turnId: string
}

/** 回合的菜单是从哪儿打开的：菜单里的“评论”要知道是哪条回答，回退、分叉要知道是哪条用户消息 */
let pressed: { turnId: string; itemId: string | null } | null = null

/**
 * 打开回合的菜单之前记下是从哪儿打开的：长按回答、用户消息的单元格给它的条目，状态行的“⋯”给 null。
 * 对话区的上下文只把回合交给菜单（Transcript.tsx 的 turnMenu），条目从这里走
 */
export function notePressed(turnId: string, itemId: string | null): void {
  pressed = { turnId, itemId }
}

/** 这一回合的菜单是从哪个条目上打开的（种类问 SessionStore.kindOf）。不是从条目上是 null */
export const pressedItem = (turnId: string): string | null =>
  pressed?.turnId === turnId ? pressed.itemId : null

const FLASH_MS = 1600

export class CommentsHub {
  picking: string | null = null
  /** 能自由选字的那条回答；不在选是 null */
  selecting: string | null = null
  /** 上一次“回复”没加上：一条消息带的评论满了 */
  replyFull = false
  /** “回复”选中的那段，正在写评论（对话框开着）；没在写是 null */
  replying: { itemId: string; quote: string } | null = null
  shown: ShownComment | null = null
  /** 要滚过去的那一行的键，对话区拿走一次 */
  jumpTo: string | null = null
  flashed: string | null = null
  private readonly listeners = new Set<() => void>()
  private readonly parsed = new WeakMap<UserMessageItem, ParsedComments | null>()

  constructor(
    readonly store: SessionStore,
    /** 输入框草稿的键（composer/drafts.ts），评论加到这里 */
    readonly draftKey: string,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** 这一回合的用户消息带的评论。没带、认不出是 null；同一条消息只认一次 */
  commentsOf(turnId: string): ParsedComments | null {
    const user = this.store.userMessage(turnId)
    if (!user) return null
    if (this.parsed.has(user)) return this.parsed.get(user) ?? null
    const found = parseComments(user.text)
    this.parsed.set(user, found)
    return found
  }

  /** 打开全文页，在这条回答里选字 */
  pick(itemId: string | null): void {
    this.picking = itemId
    this.notify()
  }

  /** 让这条回答能自由选字；null 是不选了 */
  select(itemId: string | null): void {
    this.selecting = itemId
    this.replyFull = false
    this.notify()
  }

  /** 回复选中的一段：不选了，打开写评论的对话框。满了加不上返回 false（留在选字里） */
  reply(itemId: string, text: string): boolean {
    const quote = text.trim()
    if (!quote) return false
    if (loadDraftComments(this.draftKey).length >= MAX_COMMENTS) {
      this.replyFull = true
      this.notify()
      return false
    }
    this.replying = { itemId, quote }
    this.select(null)
    return true
  }

  /** 写好了（可以不写）：引用带着评论加到输入框上面。取消是 null，什么都不加 */
  replied(note: string | null): void {
    const replying = this.replying
    if (!replying) return
    this.replying = null
    this.notify()
    if (note === null) return
    addDraftComment(this.draftKey, { kind: 'comment', ...replying, note })
  }

  show(shown: ShownComment | null): void {
    this.shown = shown
    this.notify()
  }

  /** 原文在对话的哪一行，找不到是 null（只看已经有的行，不看还在流式的那一块） */
  locate(target: QuoteTarget): string | null {
    const rows = this.store.getSnapshot().rows
    const index = findQuote(rows, target)
    return index < 0 ? null : (rows[index]?.key ?? null)
  }

  /** 滚到原文那一行、闪一下。找不到返回 false */
  jump(target: QuoteTarget): boolean {
    const key = this.locate(target)
    if (!key) return false
    this.jumpTo = key
    this.notify()
    return true
  }

  /** 对话区拿走要滚到的那一行（只拿一次） */
  takeJump(): string | null {
    const key = this.jumpTo
    if (key === null) return null
    this.jumpTo = null
    // 拿走了也要说一声：下次再跳同一行，订阅的那边才看得出变化
    this.notify()
    return key
  }

  flash(key: string): void {
    this.flashed = key
    this.notify()
    setTimeout(() => {
      if (this.flashed !== key) return
      this.flashed = null
      this.notify()
    }, FLASH_MS)
  }
}
