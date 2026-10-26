// 会话的系统通知和 Dock 角标。只在桌面外壳里有，普通浏览器里什么都不做。
// 通知：核心报一个会话的摘要换了（onSessionUpdate），session-notice.ts 判断是哪一种；窗口在前台时不发。
// 标题是会话标题，小字是项目和设备，正文向核心要会话眼下的情况（session.peek）再拼。
// 点通知把窗口叫到前面（外壳做），这里打开那个会话。
// 角标：各台设备上未读的会话（keys.unread）加起来，变了就报给外壳。等审批、等回答的不算，它们只发通知；
// 侧栏用同一份让未读的会话收不起、折不住，角标上的每一个都能在侧栏里找到。
import {
  type DeviceView,
  keys,
  type SessionPeek,
  type SessionSummary,
  type WorkspaceView,
} from '@litch/core'
import { useEffect, useMemo, useRef } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { useKey, useKeys, useServices } from '../app/services.tsx'
import { noticeBodyOf, notifySessions, sessionNoticeOf } from './session-notice.ts'

const PREFIX = 'session:'
const NO_DEVICES: string[] = []

export function SessionNotices({ onOpen }: { onOpen(selection: Selection): void }) {
  const { replica, channel } = useServices()
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
      // 要不到也照发：只是正文退回到不带内容的那句
      channel
        .command('session.peek', { deviceId, sessionId: after.id })
        .catch((): SessionPeek | null => null)
        .then((peek) => {
          const t = said.current
          const device = replica.store.get<DeviceView>(keys.device(deviceId))
          const deviceName = device ? t.text(device.name) : deviceId
          const workspace = replica.store
            .get<WorkspaceView[]>(keys.workspaces(deviceId))
            ?.find((entry) => entry.id === after.workspaceId)
          const body = noticeBodyOf(kind, peek, (text) => t.text(text))
          notify({
            id: `${PREFIX}${JSON.stringify([deviceId, after.id])}`,
            title: t.text(after.title),
            subtitle: workspace ? `${workspace.name} · ${deviceName}` : deviceName,
            body: !body
              ? t(`notify.session.${kind}`, { harness: nameOf(device, after.harness) })
              : body.key === 'plain'
                ? body.text
                : t(body.key, { text: body.text }),
          })
        })
    })
  }, [replica, channel])

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
  const unreadKeys = useMemo(() => devices.map((id) => keys.unread(id)), [devices])
  const unread = useKeys<string[]>(unreadKeys)
  const total = unread.reduce<number>((sum, ids) => sum + (ids?.length ?? 0), 0)
  useEffect(() => {
    window.litchShell?.setBadge?.(total)
  }, [total])
  return null
}
