// 一个会话的持续目标：输入框上方那一行、侧面板的“目标”页、输入框里的 /goal 都用这里。
// 目标的样子在状态库里（keys.goal，核心照对面的通知整个换）；改目标一律经核心的 session.goal.*，
// 没做成的出一条提示。换掉一个还没做完的目标之前先问一句（GoalReplace.tsx 画那个对话框）。
import { keys, type SessionGoalView, type SessionMeta } from '@litch/core'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import type { MessageKey } from '../i18n/index.ts'

export function useSessionGoal(deviceId: string, sessionId: string | null): SessionGoalView | null {
  return useKey<SessionGoalView | null>(sessionId ? keys.goal(deviceId, sessionId) : '') ?? null
}

/** 这个会话能不能有目标：harness 会、会话能发消息 */
export function useGoalsAble(deviceId: string, sessionId: string | null): boolean {
  const meta = useKey<SessionMeta>(sessionId ? keys.session(deviceId, sessionId) : '')
  return meta?.can.goals === true && meta.live
}

const failed = (key: MessageKey, error: unknown) =>
  showToast({
    id: `goal-${key}`,
    tone: 'err',
    lifeMs: 8000,
    text: (say) => say(key, { reason: whyNot(error, say) }),
  })

export interface GoalActions {
  /**
   * 设新目标、改目标的话，同时让它进行（照官方桌面端：改了话的目标就是要接着做的，暂停着的也跟着继续）。
   * 成了返回 true；没成出提示、返回 false
   */
  write(objective: string): Promise<boolean>
  /** 暂停或继续 */
  status(status: 'active' | 'paused'): Promise<boolean>
  clear(): Promise<boolean>
}

export function useGoalActions(deviceId: string, sessionId: string): GoalActions {
  const { channel } = useServices()
  const run = useCallback(
    async (key: MessageKey, work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work()
        return true
      } catch (error) {
        failed(key, error)
        return false
      }
    },
    [],
  )
  return useMemo(
    () => ({
      write: (objective) =>
        run('goal.failed.set', () =>
          channel.command('session.goal.set', {
            deviceId,
            sessionId,
            objective,
            status: 'active',
          }),
        ),
      status: (status) =>
        run('goal.failed.update', () =>
          channel.command('session.goal.set', { deviceId, sessionId, status }),
        ),
      clear: () =>
        run('goal.failed.clear', () =>
          channel.command('session.goal.clear', { deviceId, sessionId }),
        ),
    }),
    [channel, deviceId, sessionId, run],
  )
}

// ---------- 换掉还没做完的目标之前问一句 ----------

interface Asking {
  objective: string
  answer(yes: boolean): void
}

let asking: Asking | null = null
const listeners = new Set<() => void>()
const publish = (next: Asking | null) => {
  asking = next
  for (const listener of listeners) listener()
}

/** 问“换掉吗”：用户点了换就是 true，不换、按 Esc、点到外面是 false。同时只问一个，后来的先把前一个当作不换 */
export function askReplace(objective: string): Promise<boolean> {
  asking?.answer(false)
  return new Promise((resolve) => {
    const entry: Asking = {
      objective,
      answer: (yes) => {
        if (asking === entry) publish(null)
        resolve(yes)
      },
    }
    publish(entry)
  })
}

export function useReplaceAsk(): Asking | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => asking,
  )
}
