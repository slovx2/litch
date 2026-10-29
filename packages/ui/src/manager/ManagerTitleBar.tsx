import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { requestManagers, requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf, wireStyle } from '../app/device.ts'
import { useKey } from '../app/services.tsx'
import { PowerShortcut } from '../devices/PowerShortcut.tsx'
import { MachineMarker } from '../machine/MachineMarker.tsx'
import { RailToggle } from '../rail/InfoRail.tsx'
import { SideToggle } from '../side/SideSlot.tsx'
import { SidebarToggle } from '../sidebar/SidebarFrame.tsx'
import { TerminalToggle } from '../terminal/TerminalSlot.tsx'

/** 经理入口的标题栏，普通对话继续使用原来的 TitleBar。 */
export function ManagerTitleBar({
  manager,
  child,
}: {
  manager?: ManagerView
  child?: SessionSummary
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(manager?.deviceId ?? ''))
  return (
    <header className="tb" style={wireStyle(device?.wire)}>
      <SidebarToggle
        onCompose={() =>
          requestManagers({ view: 'new', ...(manager ? { deviceId: manager.deviceId } : {}) })
        }
      />
      <nav className="crumb" aria-label={t('title.location')}>
        {device ? (
          <>
            <span className="dev">
              <i className="wire-sq" />
              {t.text(device.name)}
            </span>
            <span className="sep">/</span>
          </>
        ) : null}
        <span>{t('manager.manager')}</span>
        {manager ? (
          <>
            <span className="sep">/</span>
            {child ? (
              <button
                type="button"
                className="ell"
                onClick={() =>
                  requestOpenSession({ deviceId: manager.deviceId, sessionId: manager.threadId })
                }
              >
                {manager.name}
              </button>
            ) : (
              <b className="ell">{manager.name}</b>
            )}
          </>
        ) : null}
        {child ? (
          <>
            <span className="sep">/</span>
            <b className="ell">{t.text(child.title)}</b>
          </>
        ) : null}
        {manager ? (
          <span className="chip" title={nameOf(device, child?.harness ?? manager.harness)}>
            {badgeOf(device, child?.harness ?? manager.harness)}
          </span>
        ) : null}
      </nav>
      <MachineMarker />
      <PowerShortcut deviceId={manager?.deviceId ?? 'local'} />
      {child ? (
        <>
          <TerminalToggle />
          <RailToggle />
        </>
      ) : null}
      {manager ? <SideToggle /> : null}
    </header>
  )
}
