// 子会话对话最上面那一行：“由 <父会话> 派出：<标题>”，点父会话的名字回去；行尾“脱离成独立会话”。
// 父会话不在侧栏里（归档了、删了）就只写一句，不给点。和“分叉自”那一行是同一个位置、同一种样子。
// 别的应用派出、认得出父会话的（Claude 桌面端起的子会话）也有这一行，但只能回到父会话：没有标题、不能脱离。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Confirm } from '../app/Confirm.tsx'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'

interface LineageBarProps {
  deviceId: string
  sessionId: string
  onOpen: ((selection: { deviceId: string; sessionId: string }) => void) | undefined
}

export function LineageBar({ deviceId, sessionId, onOpen }: LineageBarProps) {
  const { channel } = useServices()
  const t = useT()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const lineage = summary?.lineage ?? null
  const native = lineage ? null : (summary?.nativeLineage ?? null)
  const parentId = lineage?.parentId ?? native?.parentId ?? null
  const parent = useKey<SessionSummary>(keys.summary(deviceId, parentId ?? ''))
  const [asking, setAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!parentId) return null
  const name = parent ? t.text(parent.title) || t('session.untitled') : null
  // 脱离是设备层的事：设备连着、声明了会话树就能做，不用经过 harness
  const detachable = device?.connection === 'online' && device.sessionTree
  const detach = () => {
    setAsking(false)
    setFailure(null)
    channel
      .command('session.detach', { deviceId, sessionId })
      .catch((error: unknown) => setFailure(t('session.failed', { reason: reasonOf(error, t) })))
  }
  return (
    <div
      className="forked-from lineage"
      data-parent={parentId}
      data-native={native ? native.app : undefined}
    >
      <span>{t('tree.lineage.before')}</span>
      {name !== null && onOpen ? (
        <button
          type="button"
          className="forked-link"
          title={t('tree.lineage.open')}
          onClick={() => onOpen({ deviceId, sessionId: parentId })}
        >
          {name}
        </button>
      ) : (
        <span className="forked-gone">{name ?? t('tree.lineage.unknown')}</span>
      )}
      {lineage ? (
        <span className="lineage-title">{t('tree.lineage.after', { title: lineage.title })}</span>
      ) : (
        <span className="lineage-title">
          {t(
            native?.app === 'claude-desktop'
              ? 'tree.lineage.claudeDesktop'
              : 'tree.lineage.otherApp',
          )}
        </span>
      )}
      <span className="grow" />
      {lineage?.wakeParent === false ? <span>{t('tree.lineage.noWake')}</span> : null}
      {lineage && detachable ? (
        <button type="button" className="mini" data-act="detach" onClick={() => setAsking(true)}>
          {t('tree.detach')}
        </button>
      ) : null}
      {failure ? <span className="err">{failure}</span> : null}
      {asking ? (
        <Confirm
          title={t('tree.detach.title')}
          note={t('tree.detach.note')}
          yes={t('tree.detach.yes')}
          no={t('tree.dialog.cancel')}
          onYes={detach}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </div>
  )
}
