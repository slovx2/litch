// 会话的系统通知：侧栏里一个会话的摘要换了，看换之前、换之后两份，判断要不要发、发哪一种。
// 照 Codex、Claude 桌面端的规矩：回合结束（成了、出错）和停下来要人处理（审批、回答）才发；
// 窗口在前台时不发（SessionNotices.tsx 管），定时任务跑出来的会话由 TaskNotices 发，这里不重复。
// 子会话、别的应用派出来的会话回合结束不发（父会话会收到回报，发了太吵）；它们停下来要人处理照发。
// 正文照两家桌面端写实际内容：回合结束写最后一条回答的开头，出错写原因，要审批写要做的事（命令原文），
// 要回答写问题本身；拿不到（设备没连着、对面要不到）退回到“某某回合已结束”那样的一句。
import type { SessionPeek, SessionPeekPending, SessionSummary, Text } from '@litch/core'
import { useSyncExternalStore } from 'react'

export type SessionNoticeKind = 'done' | 'failed' | 'approval' | 'answer'

/** 正文最多多少个字：通知中心里大约两三行 */
export const NOTICE_BODY_MAX = 100

/** 回答是 Markdown：去掉代码块的围栏、标题和列表的记号、强调和链接的写法，空白并成一个空格 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按字（不是 UTF-16 单元）掐到 max 个，掐了的末尾加省略号 */
export function clipText(text: string, max = NOTICE_BODY_MAX): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

export type NoticeBodyKey =
  | 'notify.session.failedWith'
  | 'notify.session.run'
  | 'notify.session.edit'
  | 'notify.session.tool'
  | 'notify.session.permissions'
  | 'notify.session.allow'

/** 正文：原文一句（plain），或者一句带前缀的（key 加 text）。null 是没内容可写，用不带内容的那句 */
export type NoticeBody = { key: 'plain' | NoticeBodyKey; text: string } | null

const PENDING_KEYS: Record<SessionPeekPending['kind'], NoticeBodyKey | 'plain'> = {
  command: 'notify.session.run',
  fileChange: 'notify.session.edit',
  tool: 'notify.session.tool',
  permissions: 'notify.session.permissions',
  question: 'plain',
  form: 'plain',
  other: 'notify.session.allow',
}

export function noticeBodyOf(
  kind: SessionNoticeKind,
  peek: SessionPeek | null,
  say: (text: Text) => string,
): NoticeBody {
  const line = (key: 'plain' | NoticeBodyKey, raw: string): NoticeBody => {
    const text = clipText(key === 'plain' ? plainText(raw) : raw.replace(/\s+/g, ' ').trim())
    return text ? { key, text } : null
  }
  if (!peek) return null
  if (kind === 'done') return line('plain', peek.answer ?? '')
  if (kind === 'failed') return line('notify.session.failedWith', peek.error ?? '')
  const pending = peek.pending
  if (!pending) return null
  // 要回答却只认出一条在等批准的命令（没打开的会话只能这么猜），或者反过来：对不上的不写
  if ((kind === 'answer') !== (pending.kind === 'question' || pending.kind === 'form')) return null
  return line(PENDING_KEYS[pending.kind], say(pending.text))
}

export function sessionNoticeOf(
  before: SessionSummary | undefined,
  after: SessionSummary,
): SessionNoticeKind | null {
  // 刚出现的会话（新建、别处建的）：没有“变成”什么，不发
  if (!before) return null
  if (after.task?.kind === 'run') return null
  if (after.status === 'waiting') {
    if (before.status === 'waiting' && before.waitingFor === after.waitingFor) return null
    return after.waitingFor === 'answer' ? 'answer' : 'approval'
  }
  if (before.status !== 'running') return null
  if (after.status === 'error') return 'failed'
  if (after.status !== 'idle') return null
  if (after.lineage || after.nativeLineage) return null
  return 'done'
}

// ---------- 设置里的开关：存在这台电脑的本地存储里，默认开 ----------
const KEY = 'litch.notify.sessions'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

let current = read()

export const notifySessions = (): boolean => current

export function setNotifySessions(on: boolean): void {
  current = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useNotifySessions = (): boolean => useSyncExternalStore(subscribe, notifySessions)
