// 会话里的输入框发出 `/goal 要做到的事`：harness 会目标时不当消息发，设成这个会话的持续目标（session.goal.set）。
// 照桌面的 goal/send.ts：没写字、带图片或评论的不收（抛错，输入框把字还给用户、写明原因）；
// 还没做完的目标要换掉之前先问一句，不换的话字也还回去。问的那个对话框由调用的一方画（confirm）
import type { CommentExtra, ImageAttachment } from '@litch/core'
import { type ReactNode, useRef, useState } from 'react'
import type { SessionMeta } from '../../core/session-store'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Confirm } from '../../ui/kit/overlays'
import { goalIntent } from './logic'

type Send = (text: string, images: ImageAttachment[], comments: CommentExtra[]) => Promise<void>

export function useGoalSend(
  deviceId: string,
  sessionId: string,
  meta: SessionMeta | null,
  send: Send,
): { send: Send; confirm: ReactNode } {
  const t = useT()
  const channel = useChannel()
  const [asking, setAsking] = useState<string | null>(null)
  const answer = useRef<((yes: boolean) => void) | null>(null)
  const ask = (objective: string) =>
    new Promise<boolean>((resolve) => {
      answer.current?.(false)
      answer.current = (yes) => {
        answer.current = null
        setAsking(null)
        resolve(yes)
      }
      setAsking(objective)
    })
  const able = meta?.can.goals === true && meta.live
  const current = meta?.goal ?? null
  const wrapped: Send = async (text, images, comments) => {
    const intent = goalIntent(text, images.length + comments.length, able, current)
    if (intent.kind === 'send') return send(text, images, comments)
    if (intent.kind === 'refuse') throw new Error(t(intent.key))
    if (intent.kind === 'ask' && !(await ask(intent.objective)))
      throw new Error(t('goal.replace.kept'))
    await channel.command('session.goal.set', {
      deviceId,
      sessionId,
      objective: intent.objective,
      status: 'active',
    })
  }
  const confirm = (
    <Confirm
      visible={asking !== null}
      title={t('goal.replace.title')}
      detail={t('goal.replace.note', { objective: asking ?? '' })}
      confirmLabel={t('goal.replace.yes')}
      // 点“换”时对话框先关再确认：关的那一下晚一拍当作不换，确认先到就是换
      onClose={() => setTimeout(() => answer.current?.(false), 0)}
      onConfirm={() => answer.current?.(true)}
    />
  )
  return { send: wrapped, confirm }
}
