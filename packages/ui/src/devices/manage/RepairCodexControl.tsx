import type { HarnessView } from '@litch/core'
import { useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Confirm } from '../../app/Confirm.tsx'
import { whyNot } from '../../app/errors.ts'
import { useServices } from '../../app/services.tsx'

/** 只显示设备为当前失败提供的动作；确认前不发送请求。 */
export function RepairCodexControl({
  deviceId,
  harness,
}: {
  deviceId: string
  harness: HarnessView | undefined
}) {
  const t = useT()
  const { channel } = useServices()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const offered =
    harness?.id === 'codex' &&
    harness.down === 'startFailed' &&
    harness.state === 'unavailable' &&
    harness.repair === 'codexControlPermissions'
  const repair = async () => {
    setAsking(false)
    setBusy(true)
    setError(null)
    try {
      const result = await channel.command('device.harness.restart', {
        deviceId,
        harness: 'codex',
        repair: 'codexControlPermissions',
      })
      if (!result.running) setError(result.text ? t.said(result.text) : t('harness.unavailable'))
    } catch (failed) {
      setError(whyNot(failed, t))
    } finally {
      setBusy(false)
    }
  }
  if (!offered && !busy && !error) return null
  return (
    <div className="mng-h-why" data-codex-repair>
      {offered || busy ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-act="repair-codex-control"
          onClick={() => setAsking(true)}
        >
          {t(busy ? 'manage.repair.busy' : 'manage.repair')}
        </button>
      ) : null}
      {error ? <div role="alert">{t('manage.repair.failed', { reason: error })}</div> : null}
      {asking ? (
        <Confirm
          title={t('manage.repair.title')}
          note={t('manage.repair.note')}
          tone="primary"
          yes={t('manage.repair.confirm')}
          no={t('add.cancel')}
          onYes={() => void repair()}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}
