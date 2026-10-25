// 会话的系统通知：侧栏里一个会话的摘要换了，看换之前、换之后两份，判断要不要发、发哪一种。
// 照 Codex、Claude 桌面端的规矩：回合结束（成了、出错）和停下来要人处理（审批、回答）才发；
// 窗口在前台时不发（SessionNotices.tsx 管），定时任务跑出来的会话由 TaskNotices 发，这里不重复。
// 子会话、别的应用派出来的会话回合结束不发（父会话会收到回报，发了太吵）；它们停下来要人处理照发。
import type { SessionSummary } from '@litch/core'
import { useSyncExternalStore } from 'react'

export type SessionNoticeKind = 'done' | 'failed' | 'approval' | 'answer'

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
