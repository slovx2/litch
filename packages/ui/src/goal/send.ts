// 会话里的输入框发出 `/goal 要做到的事`：不当消息发，设成这个会话的持续目标（harness 会才这样，
// 不会的照常当一句话发出去）。还没做完的目标要换掉之前先问一句；只打了 /goal 的，有目标就打开右侧的“目标”页。
// 没做成照输入框的规矩抛错：字还给用户，写明原因
import { type ImageAttachment, keys, type MessageExtra, type SessionGoalView } from '@litch/core'
import { useCallback } from 'react'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { showSideTab } from '../side/side.ts'
import { asksBeforeReplace, parseGoalCommand } from './logic.ts'
import { askReplace, useGoalsAble } from './state.ts'
import { GOAL_TAB } from './tab.ts'

type Send = (text: string, images: ImageAttachment[], extras: MessageExtra[]) => Promise<unknown>

export function useGoalSend(deviceId: string, sessionId: string, send: Send): Send {
  const t = useT()
  const { channel, replica } = useServices()
  const able = useGoalsAble(deviceId, sessionId)
  return useCallback(
    async (text, images, extras) => {
      const parsed = able ? parseGoalCommand(text) : null
      if (!parsed) return send(text, images, extras)
      const current = replica.store.get<SessionGoalView | null>(keys.goal(deviceId, sessionId))
      if (!parsed.objective) {
        if (!current) throw new Error(t('goal.needText'))
        showSideTab(GOAL_TAB)
        return
      }
      if (images.length > 0 || extras.length > 0) throw new Error(t('goal.textOnly'))
      if (asksBeforeReplace(current, parsed.objective) && !(await askReplace(parsed.objective)))
        throw new Error(t('goal.replace.kept'))
      await channel.command('session.goal.set', {
        deviceId,
        sessionId,
        objective: parsed.objective,
        status: 'active',
      })
    },
    [able, channel, replica, deviceId, sessionId, send, t],
  )
}
