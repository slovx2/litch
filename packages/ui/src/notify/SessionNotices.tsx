// 会话的系统通知和 Dock 角标。只在桌面外壳里有，普通浏览器里什么都不做。
// 通知：核心报一个会话的摘要换了（onSessionUpdate），session-notice.ts 判断是哪一种；窗口在前台时不发。
// 点通知把窗口叫到前面（外壳做），这里打开那个会话。
// 角标：各台设备上要人看一眼的会话（等人的、没看过的）加起来，变了就报给外壳。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useEffect, useMemo, useRef } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { notifySessions, sessionNoticeOf } from './session-notice.ts'

const PREFIX = 'session:'
const NO_DEVICES: string[] = []

export function SessionNotices({ onOpen }: { onOpen(selection: Selection): void }) {
  const { replica } = useServices()
  const t = useT()
  const said = useRef(t)
  said.current = t
  const open = useRef(onOpen)
  open.current = onOpen

  useEffect(() => {
    const shell = window.litchShell
    if (!shell?.notify) return
    const notify = shell.notify.bind(shell)
    return replica.onSessionUpdate((deviceId, before, after) => {
      if (!notifySessions() || document.hasFocus()) return
      const kind = sessionNoticeOf(before, after)
      if (!kind) return
      const t = said.current
      const device = replica.store.get<DeviceView>(keys.device(deviceId))
      notify({
        id: `${PREFIX}${JSON.stringify([deviceId, after.id])}`,
        title: t.text(after.title),
        body: t(`notify.session.${kind}`, {
          harness: nameOf(device, after.harness),
          device: device ? t.text(device.name) : deviceId,
        }),
      })
    })
  }, [replica])

  useEffect(
    () =>
      window.litchShell?.onNotifyClick?.((id) => {
        if (!id.startsWith(PREFIX)) return
        const [deviceId, sessionId] = JSON.parse(id.slice(PREFIX.length)) as [string, string]
        // 会话在这之间被删、被归档了：只把窗口叫到前面
        if (replica.store.get<SessionSummary>(keys.summary(deviceId, sessionId)))
          open.current({ deviceId, sessionId })
      }),
    [replica],
  )

  const devices = useKey<string[]>(keys.devices) ?? NO_DEVICES
  const attentionKeys = useMemo(() => devices.map((id) => keys.attention(id)), [devices])
  const counts = useKeys<number>(attentionKeys)
  const total = counts.reduce<number>((sum, n) => sum + (n ?? 0), 0)
  useEffect(() => {
    window.litchShell?.setBadge?.(total)
  }, [total])
  return null
}
