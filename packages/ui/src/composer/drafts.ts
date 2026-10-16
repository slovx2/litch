// 没发出去的草稿，按会话存在浏览器的本地存储里：切走再回来、重开应用都还在。
// 存取失败（存储被禁用、满了）时退回到只在内存里记。
// 草稿里的图片和别的附带项只在内存里记：切走再回来还在，重开应用就没了（图片太大，不往本地存储里放；
// 附带项指着设备上的东西，隔了一次重开未必还在）。
import type { ImageAttachment, MessageExtra } from '@litch/core'

const STORE_KEY = 'litch.drafts'
/** 草稿最多留这么多个会话的，超出时丢掉最早写的 */
const LIMIT = 200

let cache: Map<string, string> | null = null

function all(): Map<string, string> {
  if (cache) return cache
  cache = new Map()
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
          cache.set(entry[0], entry[1])
      }
    }
  } catch {
    // 读不出来就当没有草稿
  }
  return cache
}

function persist(drafts: Map<string, string>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...drafts]))
  } catch {
    // 存不进去不影响这次使用
  }
}

export const loadDraft = (key: string): string => all().get(key) ?? ''

export function saveDraft(key: string, text: string): void {
  const drafts = all()
  if ((drafts.get(key) ?? '') === text) return
  // 删了再放，最近写的排在最后
  drafts.delete(key)
  if (text) drafts.set(key, text)
  while (drafts.size > LIMIT) {
    const oldest = drafts.keys().next().value
    if (oldest === undefined) break
    drafts.delete(oldest)
  }
  persist(drafts)
}

export const dropDraft = (key: string): void => saveDraft(key, '')

/** 开着的输入区：草稿的键 → 往它的输入框里放东西 */
const refillers = new Map<string, (text: string, images: ImageAttachment[]) => void>()

/** 输入区开着的时候登记自己，别处要把一段话放回输入框时找它。返回取消登记的函数 */
export function onRefill(
  key: string,
  refill: (text: string, images: ImageAttachment[]) => void,
): () => void {
  refillers.set(key, refill)
  return () => {
    if (refillers.get(key) === refill) refillers.delete(key)
  }
}

/** 已经写了一半的字不能冲掉：放回来的话排在前面，原来写的跟在后面 */
export const joinDraft = (back: string, draft: string): string =>
  draft.trim() ? (back ? `${back}\n\n${draft}` : draft) : back

/**
 * 把一段话（回退掉的那条消息）放回一个会话的输入框，给用户改了重发。
 * 输入区开着就直接放进去；没开着就写进草稿，下次打开时在。
 */
export function refillDraft(key: string, text: string, list: ImageAttachment[]): void {
  const refill = refillers.get(key)
  if (refill) {
    refill(text, list)
    return
  }
  saveDraft(key, joinDraft(text, loadDraft(key)))
  saveDraftImages(key, [...list, ...loadDraftImages(key)])
}

// ---------- 往输入框里加一样东西（文件面板的“加入对话”） ----------

/**
 * 要加进输入框的一样东西。现在只有文件（或者目录），可以带行号。
 * 给的是“是什么”，不是一段现成的字：输入区把它变成随消息带的一片（和打 @ 选中的是同一种，extras.ts 的 fileExtra）；
 * 带了行号的片上放不下，还是写成 路径:行号 的字插在光标那里（mentionText）。
 */
export interface Mention {
  kind: 'file'
  /** 相对于工作区根的路径，目录带斜杠 */
  path: string
  /** 设备上完整的路径 */
  full: string
  dir: boolean
  line?: number | null
}

/** 带行号的写法：路径:行号 */
export const mentionText = (mention: Mention): string =>
  mention.line ? `${mention.path}:${mention.line}` : mention.path

/**
 * 把一段字插进草稿里光标所在的地方（选中了一段就换掉那一段）。前后紧挨着别的字的话各垫一个空格，
 * 插完光标落在它后面
 */
export function insertIntoDraft(
  draft: string,
  piece: string,
  start: number,
  end: number,
): { text: string; caret: number } {
  const from = Math.max(0, Math.min(start, draft.length))
  const to = Math.max(from, Math.min(end, draft.length))
  const before = draft.slice(0, from)
  const after = draft.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const tail = /^\s/.test(after) ? '' : ' '
  const head = `${before}${lead}${piece}${tail}`
  return { text: head + after, caret: head.length }
}

/** 开着的输入区，后登记的在后面。眼前同时只有一个输入区，用最后登记的那个 */
const mentioners: ((mention: Mention) => void)[] = []

/** 输入区开着的时候登记自己：别处要往输入框里加东西时找它。返回取消登记的函数 */
export function onMention(insert: (mention: Mention) => void): () => void {
  mentioners.push(insert)
  return () => {
    const at = mentioners.lastIndexOf(insert)
    if (at >= 0) mentioners.splice(at, 1)
  }
}

/** 往眼前的输入框里加一样东西。眼前没有输入区（正停在审批上、开着别的页面）就什么都不做，返回 false */
export function mentionInComposer(mention: Mention): boolean {
  const insert = mentioners.at(-1)
  if (!insert) return false
  insert(mention)
  return true
}

const images = new Map<string, ImageAttachment[]>()
const NO_IMAGES: ImageAttachment[] = []

export const loadDraftImages = (key: string): ImageAttachment[] => images.get(key) ?? NO_IMAGES

export function saveDraftImages(key: string, list: ImageAttachment[]): void {
  if (list.length > 0) images.set(key, list)
  else images.delete(key)
}

const extras = new Map<string, MessageExtra[]>()
const NO_EXTRAS: MessageExtra[] = []

export const loadDraftExtras = (key: string): MessageExtra[] => extras.get(key) ?? NO_EXTRAS

export function saveDraftExtras(key: string, list: MessageExtra[]): void {
  if (list.length > 0) extras.set(key, list)
  else extras.delete(key)
}
