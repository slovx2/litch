// 一个会话详情页里评论这件事的中枢：对话区的单元格、长按菜单、输入框上的评论片和几个浮层都经它说话。
// 详情页建一个、经上下文给下去（context.tsx）。上下文的值一直是同一个对象，单元格不会因为它重画；
// 会变的状态（在选字的是哪条回答、弹出的是哪条评论、要滚到哪一行、哪一行在闪）放在它自己身上，用的地方订阅。
import {
  type ParsedComment,
  type ParsedComments,
  parseComments,
  type UserMessageItem,
} from '@litch/core'
import type { SessionStore } from '../../core/session-store'
import { findQuote, type QuoteTarget } from './refs'

/** 弹出来看的一条评论：发出去的那些（卡片、回答里的 [N]） */
export interface ShownComment {
  comment: ParsedComment
  /** 带着这条评论的用户消息在哪一回合（找原文时从这里往前找） */
  turnId: string
}

/** 回合的菜单是从哪儿打开的：菜单里的“评论”要知道是哪条回答 */
let pressed: { turnId: string; itemId: string | null } | null = null

/**
 * 打开回合的菜单之前记下是从哪儿打开的：长按回答的单元格给它的条目，别处（用户消息、状态行的“⋯”）给 null。
 * 对话区的上下文只把回合交给菜单（Transcript.tsx 的 turnMenu），条目从这里走
 */
export function notePressedAnswer(turnId: string, itemId: string | null): void {
  pressed = { turnId, itemId }
}

/** 这一回合的菜单是从哪条回答上打开的。不是从回答上是 null */
export const pressedAnswer = (turnId: string): string | null =>
  pressed?.turnId === turnId ? pressed.itemId : null

const FLASH_MS = 1600

export class CommentsHub {
  picking: string | null = null
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
