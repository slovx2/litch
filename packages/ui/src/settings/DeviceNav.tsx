import { type DeviceView, keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { Machine, Plus } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { StatePill } from '../devices/status.tsx'

function DeviceLink({
  deviceId,
  active,
  onOpen,
}: {
  deviceId: string
  active: boolean
  onOpen(): void
}) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  if (!device) return null
  return (
    <button
      type="button"
      className="set-device"
      data-settings-device={deviceId}
      aria-current={active ? 'page' : undefined}
      style={wireStyle(device.wire)}
      title={`${t.text(device.name)} · ${device.host}`}
      onClick={onOpen}
    >
      <i className={device.connection === 'online' ? 'wire-sq' : 'wire-sq off'} />
      <span className="ell grow">{t.text(device.name)}</span>
      <StatePill device={device} />
    </button>
  )
}

/** 本机与远程设备并列，设置首页即可直接选择。 */
export function DeviceNav({
  active,
  onDevice,
  onDevices,
  onAdd,
}: {
  active: string | null
  onDevice(deviceId: string): void
  onDevices(): void
  onAdd(): void
}) {
  const t = useT()
  const ids = useKey<string[]>(keys.devices) ?? []
  return (
    <>
      <div className="set-nav-label">
        <button type="button" className="set-go grow" data-page="devices" onClick={onDevices}>
          <Machine />
          <span>{t('sidebar.devices')}</span>
        </button>
        <button
          type="button"
          className="ibtn"
          data-act="settings-add-device"
          title={t('sidebar.addDevice')}
          aria-label={t('sidebar.addDevice')}
          onClick={onAdd}
        >
          <Plus />
        </button>
      </div>
      {ids.map((id) => (
        <DeviceLink key={id} deviceId={id} active={active === id} onOpen={() => onDevice(id)} />
      ))}
    </>
  )
}
