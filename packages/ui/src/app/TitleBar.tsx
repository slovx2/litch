import { type DeviceView, keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import type { PlaceWish } from '../composer/new-place.ts'
import { useNewHarness } from '../composer/remembered.ts'
import { PowerShortcut } from '../devices/PowerShortcut.tsx'
import { MachineMarker } from '../machine/MachineMarker.tsx'
import { RailToggle } from '../rail/InfoRail.tsx'
import { SideToggle } from '../side/SideSlot.tsx'
import { SidebarToggle } from '../sidebar/SidebarFrame.tsx'
import { TerminalToggle } from '../terminal/TerminalSlot.tsx'
import { SessionMenu } from '../transcript/ViewMenu.tsx'
import type { Draft, Page, Selection } from './App.tsx'
import { useT } from './appearance.ts'
import { badgeOf, downHarness, downText, nameOf, wireStyle } from './device.ts'
import { useKey } from './services.tsx'

/** 标题栏：当前位置。设备 / 工作区 / 会话，后面跟 harness 的徽标 */
export function TitleBar({
  selection,
  draft,
  page,
  peek,
  onCompose,
  devicePageId,
}: {
  devicePageId: string | null
  selection: Selection | null
  /** 正在写的新会话（开着的是新建对话页）。有它的时候显示它要建在哪，跟着那一页上选的设备和工作区走 */
  draft: Draft | null
  /** 正开着“已归档对话”“设备”或“设置”那一页：位置就是这一页的名字 */
  page: Page | null
  /** 正只读地看着的那个已归档的对话 */
  peek: Selection | null
  /** 到新建对话页去。侧栏收着的时候，标题栏上那个“新对话”用它 */
  onCompose(wish: PlaceWish | null): void
}) {
  const deviceId = peek?.deviceId ?? (page ? '' : (draft?.deviceId ?? selection?.deviceId ?? ''))
  const sessionId = selection?.sessionId ?? ''
  const device = useKey<DeviceView>(keys.device(deviceId))
  const listed = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const shelved = useKey<SessionSummary[] | null>(keys.archived(peek?.deviceId ?? ''))
  // 已归档的对话不在侧栏的数据里，它的摘要在已归档的那张表里
  const summary = peek ? shelved?.find((entry) => entry.id === peek.sessionId) : listed
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  const workspaceId = draft ? draft.workspaceId : summary?.workspaceId
  const workspace = workspaces?.find((entry) => entry.id === workspaceId)
  // 正在写的新会话：跟着那一页上选的 harness 走
  const fresh = useNewHarness(device, draft?.workspaceId ?? null)
  const harness = draft ? fresh?.id : summary?.harness
  const down = downHarness(device, harness)
  const t = useT()

  return (
    <header className="tb" style={wireStyle(device?.wire)}>
      <SidebarToggle onCompose={() => onCompose(null)} />
      <nav className="crumb" aria-label={t('title.location')}>
        {device && (draft || summary) ? (
          <>
            <span className="dev">
              <i className="wire-sq" />
              {t.text(device.name)}
            </span>
            <span className="sep">/</span>
            <span className="ell">{workspace?.name ?? t('workspace.none')}</span>
            <span className="sep">/</span>
            <b className="ell">{summary ? t.text(summary.title) : t('newSession.title')}</b>
            {harness ? (
              <span
                className={down ? 'chip off' : 'chip'}
                title={down ? downText(down, 'chip', t) : nameOf(device, harness)}
              >
                {badgeOf(device, harness)}
              </span>
            ) : null}
            {peek ? <span className="pill mute">{t('archived.badge')}</span> : null}
            {/* 开着一个会话（含只读地看已归档的）：标题后面是这个会话的菜单（对话区的两档视图） */}
            {summary && !draft ? (
              <SessionMenu deviceId={deviceId} sessionId={peek?.sessionId ?? sessionId} />
            ) : null}
          </>
        ) : (
          <b>
            {page === 'archived'
              ? t('archived.title')
              : page === 'devices'
                ? t('devices.title')
                : page === 'settings'
                  ? t('settings.title')
                  : page === 'tasks'
                    ? t('tasks.title')
                    : selection
                      ? 'Litch'
                      : // 新建对话页，而一台设备都没有：说不出建在哪，只写这是哪一页
                        t('newSession.title')}
          </b>
        )}
      </nav>
      {/* 远程设备在这台电脑上有动静时才出 */}
      <MachineMarker />
      <PowerShortcut
        key={
          page === 'devices' || page === 'tasks' ? (devicePageId ?? 'local') : deviceId || 'local'
        }
        deviceId={
          page === 'devices' || page === 'tasks' ? (devicePageId ?? 'local') : deviceId || 'local'
        }
      />
      <TerminalToggle />
      <RailToggle />
      <SideToggle />
    </header>
  )
}
