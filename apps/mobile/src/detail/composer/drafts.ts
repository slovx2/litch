// 没发出去的草稿，按会话记：文字存进应用文档目录的 drafts.json（离开再进、杀掉应用重开都还在），
// 图片只记在内存里（data URL 太大，不往文件里放；重开应用就没了，和桌面端一样），打 @ 提到的会话也是。
// 选中回答加的评论另存一个文件 draft-comments.json，也落盘；对话区（全文页加评论）和输入区（评论片）
// 两边都要改它，所以评论可以订阅（subscribeDraftComments），谁改了另一边跟着变。
// 写文件攒一下再写：每敲一个字同步写一次文件会占 JS 线程。离开页面时当场写（flushDrafts）。
import {
  type CommentExtra,
  type ImageAttachment,
  MAX_COMMENTS,
  type MessageExtra,
} from '@litch/core'
import { jsonFile } from '../../shell/json-file'

/** 最多留这么多个会话的草稿，超出时丢掉最早写的 */
const LIMIT = 200
const WRITE_DELAY_MS = 600

const file = jsonFile<[string, string][]>('drafts.json')
let texts: Map<string, string> | null = null
const images = new Map<string, ImageAttachment[]>()
let timer: ReturnType<typeof setTimeout> | null = null

const commentFile = jsonFile<[string, CommentExtra[]][]>('draft-comments.json')
let comments: Map<string, CommentExtra[]> | null = null
let commentTimer: ReturnType<typeof setTimeout> | null = null
const commentListeners = new Set<() => void>()
const NONE: CommentExtra[] = []

function all(): Map<string, string> {
  if (texts) return texts
  texts = new Map()
  const stored = file.read()
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
        texts.set(entry[0], entry[1])
    }
  }
  return texts
}

/** 草稿的键：哪台设备上的哪个会话。新建会话页用 `new:<设备>` */
export const draftKey = (deviceId: string, sessionId: string): string => `${deviceId}\n${sessionId}`

export const loadDraft = (key: string): string => all().get(key) ?? ''

export function saveDraft(key: string, text: string): void {
  const map = all()
  if ((map.get(key) ?? '') === text) return
  // 删了再放，最近写的排在最后
  map.delete(key)
  if (text) map.set(key, text)
  while (map.size > LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  if (timer === null) timer = setTimeout(flushDrafts, WRITE_DELAY_MS)
}

/** 攒着没写的现在写进文件 */
export function flushDrafts(): void {
  flushComments()
  if (timer !== null) clearTimeout(timer)
  timer = null
  if (!texts) return
  try {
    file.write([...texts])
  } catch {
    // 写不进去不影响这次使用
  }
}

export const loadDraftImages = (key: string): ImageAttachment[] => images.get(key) ?? []

export function saveDraftImages(key: string, list: ImageAttachment[]): void {
  if (list.length) images.set(key, list)
  else images.delete(key)
}

/** 打 @ 提到的会话（正文里是 @[标题]）：和图片一样只在内存里，按会话记 */
export type SessionExtra = Extract<MessageExtra, { kind: 'session' }>
const sessions = new Map<string, SessionExtra[]>()

export const loadDraftSessions = (key: string): SessionExtra[] => sessions.get(key) ?? []

export function saveDraftSessions(key: string, list: SessionExtra[]): void {
  if (list.length) sessions.set(key, list)
  else sessions.delete(key)
}

export function dropDraft(key: string): void {
  saveDraft(key, '')
  images.delete(key)
  sessions.delete(key)
  saveDraftComments(key, NONE)
}

const isComment = (value: unknown): value is CommentExtra => {
  const each = value as CommentExtra | null
  return (
    typeof each === 'object' &&
    each !== null &&
    each.kind === 'comment' &&
    typeof each.itemId === 'string' &&
    typeof each.quote === 'string' &&
    typeof each.note === 'string'
  )
}

function allComments(): Map<string, CommentExtra[]> {
  if (comments) return comments
  comments = new Map()
  const stored = commentFile.read()
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1]))
        continue
      const list = entry[1].filter(isComment).slice(0, MAX_COMMENTS)
      if (list.length) comments.set(entry[0], list)
    }
  }
  return comments
}

/** 这个会话草稿里的评论，按加的先后（编号就是位置加一）。没改过时返回的是同一个数组 */
export const loadDraftComments = (key: string): CommentExtra[] => allComments().get(key) ?? NONE

export function saveDraftComments(key: string, list: CommentExtra[]): void {
  const map = allComments()
  const before = map.get(key) ?? NONE
  if (before === list || (before.length === 0 && list.length === 0)) return
  map.delete(key)
  if (list.length) map.set(key, list.slice(0, MAX_COMMENTS))
  while (map.size > LIMIT) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
  if (commentTimer === null) commentTimer = setTimeout(flushComments, WRITE_DELAY_MS)
  for (const listener of commentListeners) listener()
}

/** 加一条评论，排在最后。满了（MAX_COMMENTS）加不进去，返回 false */
export function addDraftComment(key: string, comment: CommentExtra): boolean {
  const list = loadDraftComments(key)
  if (list.length >= MAX_COMMENTS) return false
  saveDraftComments(key, [...list, comment])
  return true
}

export function subscribeDraftComments(listener: () => void): () => void {
  commentListeners.add(listener)
  return () => commentListeners.delete(listener)
}

function flushComments(): void {
  if (commentTimer !== null) clearTimeout(commentTimer)
  commentTimer = null
  if (!comments) return
  try {
    commentFile.write([...comments])
  } catch {
    // 同上
  }
}
