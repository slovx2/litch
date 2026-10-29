import { type DevicePowerView, type DeviceView, keys, type SettingsSnapshotView } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'
import { PLUGGED_POWER_SETTING, powerShortcutTitle } from './power-shortcut.ts'

/** 工具栏只控制这台电脑已登记的设备服务，远程上下文不显示。 */
export function PowerShortcut({ deviceId }: { deviceId: string }) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const { replica, channel } = useServices()
  const t = useT()
  const local = device?.kind === 'local' && device.manageable
  useEffect(() => (local ? replica.openManage(deviceId) : undefined), [replica, deviceId, local])
  const power = useKey<DevicePowerView | null>(keys.managePower(deviceId))
  const snapshot = useKey<SettingsSnapshotView>(keys.manageSnapshot(deviceId))
  const failure = useKey<unknown>(keys.manageError(deviceId))
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  if (!local || !power?.supported || !snapshot || !(PLUGGED_POWER_SETTING in snapshot.values))
    return null
  const enabled = snapshot.values[PLUGGED_POWER_SETTING] === true
  const online = device.connection === 'online'
  const toggle = async () => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await channel.command('device.settings.write', {
        deviceId,
        expectedVersion: snapshot.version,
        edits: [{ key: PLUGGED_POWER_SETTING, value: !enabled }],
      })
    } catch (error) {
      showToast({
        id: 'power-setting',
        tone: 'err',
        lifeMs: 6000,
        text: (t) => t('power.quick.failed', { reason: whyNot(error, t) }),
      })
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const title = powerShortcutTitle(power, enabled, online, t)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={title}
      title={title}
      className={`ibtn power-shortcut${enabled ? ' on' : ''}`}
      data-power-shortcut
      data-source={online ? power.powerSource : 'unknown'}
      disabled={busy || !online || Boolean(failure)}
      onClick={() => void toggle()}
    >
      <Icon name="plug" />
    </button>
  )
}
