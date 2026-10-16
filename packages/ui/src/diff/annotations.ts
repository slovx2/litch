// 差异里的行内批注：记在哪个文件、哪一边、第几行到第几行，写了什么。按会话存（这台电脑上，litch.diff.notes），
// 发下一条消息时接在消息后面一起发出去，发出去就清掉。不经核心，也不用协议支持。
// 不碰页面上的元素，只管数和存取，好单独测。
import { useSyncExternalStore } from 'react'

export interface DiffNote {
  id: string
  /** 相对于工作目录的路径 */
  path: string
  /** old：改动前的版本（删掉的行）；next：改动后的版本 */
  side: 'old' | 'next'
  from: number
  to: number
  text: string
  /** 被批注的那几行原文（最多 EXCERPT_LINES 行） */
  excerpt: string[]
}

const STORAGE_KEY = 'litch.diff.notes'
/** 一个会话最多攒这么多条 */
export const NOTES_MAX = 50
export const EXCERPT_LINES = 8
const EXCERPT_CHARS = 240
const NONE: readonly DiffNote[] = []

function read(): Map<string, DiffNote[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<
      string,
      DiffNote[]
    >
    return new Map(Object.entries(parsed).filter(([, list]) => Array.isArray(list)))
  } catch {
    return new Map()
  }
}

const all = read()
const listeners = new Set<() => void>()

const publish = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(all)))
  } catch {
    // 记不下来不影响这一次
  }
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const notesKey = (deviceId: string, sessionId: string): string => `${deviceId}\n${sessionId}`

export const notesOf = (key: string): readonly DiffNote[] => all.get(key) ?? NONE

export const useNotes = (key: string): readonly DiffNote[] =>
  useSyncExternalStore(subscribe, () => notesOf(key))

const set = (key: string, list: DiffNote[]) => {
  if (list.length === 0) all.delete(key)
  else all.set(key, list)
  publish()
}

let seq = 0

export function addNote(
  key: string,
  note: Omit<DiffNote, 'id' | 'excerpt'>,
  lines: string[],
): void {
  const text = note.text.trim()
  if (!text) return
  const excerpt = lines
    .slice(0, EXCERPT_LINES)
    .map((line) => (line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line))
  const id = `n${Date.now().toString(36)}${(seq++).toString(36)}`
  set(key, [...notesOf(key), { ...note, text, id, excerpt }].slice(-NOTES_MAX))
}

export function removeNote(key: string, id: string): void {
  set(
    key,
    notesOf(key).filter((note) => note.id !== id),
  )
}

export function clearNotes(key: string): void {
  if (all.has(key)) set(key, [])
}

/** 写给模型看的那一段用哪种语言的字 */
export interface NoteWords {
  /** “对改动的批注（{n} 条）：” */
  title(n: number): string
  /** “第 {from} 行” / “第 {from}–{to} 行” */
  lines(from: number, to: number): string
  old: string
  next: string
  comment: string
}

/**
 * 批注写成接在消息后面的一段字：每条是文件、哪一边的第几行、那几行原文、批注。
 * 文件和行号写在明处，模型不用猜说的是哪里
 */
export function formatNotes(notes: readonly DiffNote[], words: NoteWords): string {
  if (notes.length === 0) return ''
  const parts = [words.title(notes.length)]
  notes.forEach((note, index) => {
    const body = note.excerpt.join('\n')
    // 原文里有三个反引号的话，围栏多用一个，免得提前收尾
    const fence = body.includes('```') ? '````' : '```'
    parts.push(
      [
        `${index + 1}. \`${note.path}\` ${words.lines(note.from, note.to)}（${note.side === 'old' ? words.old : words.next}）`,
        fence,
        body,
        fence,
        `${words.comment}${note.text}`,
      ].join('\n'),
    )
  })
  return parts.join('\n\n')
}

/** 消息后面接上批注 */
export const withNotes = (text: string, notes: string): string =>
  notes ? (text.trim() ? `${text}\n\n---\n${notes}` : notes) : text

/**
 * 发消息的时候拿走这个会话攒着的批注。返回写好的那一段，和“没发成，还回去”的函数
 */
export function takeNotes(key: string, words: NoteWords): { text: string; restore(): void } {
  const taken = notesOf(key)
  if (taken.length === 0) return { text: '', restore() {} }
  set(key, [])
  return {
    text: formatNotes(taken, words),
    restore() {
      set(key, [...taken, ...notesOf(key)].slice(-NOTES_MAX))
    },
  }
}
