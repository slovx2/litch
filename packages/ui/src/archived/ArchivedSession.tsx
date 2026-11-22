import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import { ArchiveBar } from './ArchiveBar.tsx'

interface ArchivedSessionProps extends Selection {
  /** 回到打开它的列表（已归档对话、全局建议或经理看板） */
  onBack(): void
  /** 恢复成了：它回到侧栏里，接着在平常的对话区里打开 */
  onRestored(selection: Selection): void
}

/**
 * 只读地看一个已归档的对话：内容和平常的对话区一样，下面不是输入区，而是一条说明“已归档”的栏，
 * 上面有“恢复”。不恢复就发不了消息。
 */
export function ArchivedSession({ deviceId, sessionId, onBack, onRestored }: ArchivedSessionProps) {
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const shelved = useKey<SessionSummary[] | null>(keys.archived(deviceId))
  const t = useT()
  const [failure, setFailure] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const online = device?.connection === 'online'
  /** 正在恢复：这时它从已归档的表里消失是我们自己做的，不算“在别处没了” */
  const restoring = useRef(false)

  // 建议列表也能直接打开归档会话，不能依赖之前进过“已归档”列表。
  useEffect(() => {
    if (!online) return
    const controller = new AbortController()
    setLoaded(false)
    channel.command('device.loadArchived', { deviceId }, { signal: controller.signal }).then(
      () => setLoaded(true),
      (error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(t('archived.failed', { reason: reasonOf(error, t) }))
      },
    )
    return () => controller.abort()
  }, [channel, deviceId, online, t])

  // 正看着的时候它在别处被恢复或者删掉了：这一页没有着落了，回到列表
  const gone =
    loaded && Array.isArray(shelved) && !shelved.some((summary) => summary.id === sessionId)
  useEffect(() => {
    if (gone && !restoring.current) onBack()
  }, [gone, onBack])

  // Esc 回到列表
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // 开着大图：这一下 Esc 是关它的，不连带退回列表
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])

  return (
    <Transcript
      deviceId={deviceId}
      sessionId={sessionId}
      footer={
        <div className="dock" style={wireStyle(device?.wire)}>
          <div className="dock-in">
            <ArchiveBar
              key={sessionId}
              deviceId={deviceId}
              sessionId={sessionId}
              disabled={!online}
              onBack={onBack}
              onRestoring={(value) => {
                restoring.current = value
              }}
              onRestored={() => onRestored({ deviceId, sessionId })}
            />
            {failure ? <div className="cmp-hint err">{failure}</div> : null}
          </div>
        </div>
      }
    />
  )
}
