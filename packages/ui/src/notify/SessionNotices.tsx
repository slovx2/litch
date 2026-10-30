// 会话的系统通知和 Dock 角标。只在桌面外壳里有，普通浏览器里什么都不做。
// 通知：核心报一个会话的摘要换了（onSessionUpdate），session-notice.ts 判断是哪一种。照 Claude 桌面端：
// 人在前台正看着这个会话时不发，看着别的会话照发；正文向核心要会话眼下的情况（session.peek）再拼。
// 标题：回合结束、要回答的是会话标题，小字是项目和设备；要审批的是项目，小字是会话标题和设备。
// 每个会话一条回合结束的、一条要人处理的（slotOf），新的盖掉旧的；事情处理掉了、人打开了那个会话就收回。
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
import { useSidebarNativeChildren } from '../sidebar/state.ts'
import { ManagerNotices } from './ManagerNotices.tsx'
import {
  type NoticeSlot,
  noticeBodyOf,
  notifySessions,
  sessionNoticeOf,
  slotOf,
} from './session-notice.ts'

const PREFIX = 'session:'
const NO_DEVICES: string[] = []

const noticeId = (deviceId: string, sessionId: string, slot: NoticeSlot): string =>
  `${PREFIX}${JSON.stringify([deviceId, sessionId, slot])}`

/** 目录的最后一段：会话不在哪个工作区里时，审批通知的标题用它（Claude 桌面端取仓库名或目录名） */
const lastPart = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

export function SessionNotices({
  onOpen,
  selection,
}: {
  onOpen(selection: Selection): void
  /** 正开着的会话 */
  selection: Selection | null
}) {
  const { replica, channel } = useServices()
  const t = useT()
  const said = useRef(t)
  said.current = t
  const open = useRef(onOpen)
  open.current = onOpen
  const viewing = useRef(selection)
  viewing.current = selection
  const nativeShown = useRef(false)
  nativeShown.current = useSidebarNativeChildren()

  useEffect(() => {
    const shell = window.litchShell
    if (!shell?.notify) return
    const notify = shell.notify.bind(shell)
    return replica.onSessionUpdate((deviceId, before, after) => {
      // 等的事处理掉了（在这里、在手机上、被拒了、回合停了）：那一条收回
      if (before?.status === 'waiting' && after.status !== 'waiting')
        shell.closeNotice?.(noticeId(deviceId, after.id, 'ask'))
      if (!notifySessions()) return
      const kind = sessionNoticeOf(before, after, !nativeShown.current)
      if (!kind) return
      const seen = viewing.current
      if (document.hasFocus() && seen?.deviceId === deviceId && seen.sessionId === after.id) return
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
          const title = t.text(after.title)
          const project = workspace?.name ?? lastPart(after.cwd)
          const asking = kind === 'approval'
          notify({
            id: noticeId(deviceId, after.id, slotOf(kind)),
            title: asking ? project || nameOf(device, after.harness) : title,
            subtitle: asking
              ? `${title} · ${deviceName}`
              : project
                ? `${project} · ${deviceName}`
                : deviceName,
            urgent: slotOf(kind) === 'ask',
            body: !body
              ? t(`notify.session.${kind}`, { harness: nameOf(device, after.harness) })
              : body.key === 'plain'
                ? body.text
                : t(body.key, { text: body.text }),
          })
        })
    })
  }, [replica, channel])

  // 人在前台看着一个会话（刚点开，或者切回窗口时开着的就是它）：它那条回合结束的通知收回，等回答的那条也收回
  // （照 Claude 桌面端；等审批的留到处理掉）
  useEffect(() => {
    const shell = window.litchShell
    if (!shell?.closeNotice || !selection) return
    const { deviceId, sessionId } = selection
    const seen = () => {
      if (!document.hasFocus()) return
      shell.closeNotice?.(noticeId(deviceId, sessionId, 'turn'))
      const summary = replica.store.get<SessionSummary>(keys.summary(deviceId, sessionId))
      if (summary?.waitingFor === 'answer')
        shell.closeNotice?.(noticeId(deviceId, sessionId, 'ask'))
    }
    seen()
    window.addEventListener('focus', seen)
    return () => window.removeEventListener('focus', seen)
  }, [selection, replica])

  useEffect(
    () =>
      window.litchShell?.onNotifyClick?.((id) => {
        if (!id.startsWith(PREFIX)) return
        const [deviceId, sessionId] = JSON.parse(id.slice(PREFIX.length)) as [
          string,
          string,
          NoticeSlot,
        ]
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
  return <ManagerNotices onOpen={onOpen} selection={selection} />
}
