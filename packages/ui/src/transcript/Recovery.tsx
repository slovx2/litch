import { type DeviceView, keys, type TurnView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { whyNot } from '../app/errors.ts'
import { stamp } from '../app/format.ts'
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
  /** “中断并继续”会打断正在跑的回合：先问一次 */
  const [asking, setAsking] = useState(false)
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
        {pending
          ? ''
          : ` · ${t('turn.recovery.since', { time: stamp(turn.recovery.lastProgressAt, Date.now(), t.lang) })}`}
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
        {/* 会打断正在跑的回合：用错误色和“继续等待”分开 */}
        <button
          type="button"
          className="mini"
          data-tone="err"
          disabled={pending || device?.connection !== 'online'}
          onClick={() => setAsking(true)}
        >
          {t('turn.recovery.continue')}
        </button>
      </div>
      {asking ? (
        <Confirm
          title={t('turn.recovery.confirm.title')}
          note={t('turn.recovery.confirm.note')}
          yes={t('turn.recovery.continue')}
          no={t('turn.recovery.confirm.no')}
          onYes={() => {
            setAsking(false)
            void run(true)
          }}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}
