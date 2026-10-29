import { type DeviceView, keys, type TurnView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'

export function Recovery({
  deviceId,
  sessionId,
  turn,
}: {
  deviceId: string
  sessionId: string
  turn: TurnView
}) {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  const [pending, setPending] = useState(false)
  const run = async (continueTurn: boolean) => {
    if (pending) return
    setPending(true)
    try {
      const ref = { deviceId, sessionId, turnId: turn.id }
      if (continueTurn)
        await channel.command('session.recover', { ...ref, text: t('turn.recovery.prompt') })
      else await channel.command('session.dismissRecovery', ref)
    } catch (error) {
      // 中断后卡片可能已经撤下，失败原因仍要留给用户，不能随着组件卸载丢失。
      showToast({
        id: `recovery:${deviceId}:${sessionId}`,
        tone: 'err',
        lifeMs: 0,
        text: (say) => whyNot(error, say),
      })
    } finally {
      setPending(false)
    }
  }
  if (!turn.recovery) return null
  return (
    <div className="turn-recovery" role="status" data-turn-recovery={turn.recovery.reason}>
      <span>
        {pending ? t('turn.recovery.pending') : t(`turn.recovery.${turn.recovery.reason}`)}
        {device?.connection !== 'online' ? ` · ${t('turn.recovery.offline')}` : ''}
      </span>
      <div className="turn-recovery-actions">
        <button
          type="button"
          className="mini"
          disabled={pending || device?.connection !== 'online'}
          onClick={() => void run(false)}
        >
          {t('turn.recovery.wait')}
        </button>
        <button
          type="button"
          className="mini"
          disabled={pending || device?.connection !== 'online'}
          onClick={() => void run(true)}
        >
          {t('turn.recovery.continue')}
        </button>
      </div>
    </div>
  )
}
