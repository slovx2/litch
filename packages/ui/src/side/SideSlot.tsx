// 侧面板接进应用的那一小段：面板挂在哪（眼前的会话在哪台设备的哪个工作区）、开合的快捷键和应用菜单，
// 以及标题栏上的开合按钮。应用外壳（App.tsx、TitleBar.tsx）里只放这两个组件。
import { keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { Draft, Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { toggleSide, useSide } from './side.ts'
import type { SidePlace } from './tabs.ts'

// 面板第一次打开之前，它不在启动要读的那一包里
const SidePanel = lazy(() =>
  import('./SidePanel.tsx').then((module) => ({ default: module.SidePanel })),
)

const NO_ROOTS: readonly string[] = []

/**
 * 面板跟着眼前的会话走：会话在哪个工作区，面板里就是那个工作区；不属于工作区的会话，用它的工作目录；
 * 正在写的新会话看它要建在哪。眼前什么都没有就是 null。
 */
function usePlace(selection: Selection | null, draft: Draft | null): SidePlace | null {
  const deviceId = draft?.deviceId ?? selection?.deviceId ?? ''
  const summary = useKey<SessionSummary>(keys.summary(deviceId, selection?.sessionId ?? ''))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId))
  // 摘要还没到的那一帧先不动：不然面板会先闪到“没有工作区”
  const known = draft !== null || (selection !== null && summary !== undefined)
  const workspaceId = draft ? draft.workspaceId : (summary?.workspaceId ?? null)
  const cwd = draft ? null : (summary?.cwd ?? null)
  const workspace = workspaces?.find((entry) => entry.id === workspaceId)
  const roots = workspace ? workspace.roots : !draft && cwd ? [cwd] : NO_ROOTS
  // 根按内容比：侧栏每来一次增量，工作区的对象都是新的，面板不该跟着重画
  const rootsKey = roots.join('\n')
  const sessionId = draft ? null : (selection?.sessionId ?? null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: roots 按内容（rootsKey）比
  return useMemo(
    () => (known && deviceId ? { deviceId, workspaceId, roots, cwd, sessionId } : null),
    [known, deviceId, workspaceId, rootsKey, cwd, sessionId],
  )
}

/** 是不是开合侧面板的那个键：Cmd/Ctrl+Alt+B。按键位认：macOS 上 Option+B 打出来的是别的字 */
const isToggleKey = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.altKey && !event.shiftKey && event.code === 'KeyB'

export function SideSlot({
  selection,
  draft,
  page,
}: {
  selection: Selection | null
  draft: Draft | null
  page: string | null
}) {
  const place = usePlace(selection, draft)
  const { open } = useSide()
  /** 应用启动时面板是不是就开着（上次没收）。是的话那一次不算“人打开的” */
  const startedOpen = useRef(open)
  /** 面板打开过没有：打开过就一直留在页面里，收起只是不显示 */
  const [loaded, setLoaded] = useState(open)
  useEffect(() => {
    if (open) setLoaded(true)
  }, [open])

  useEffect(() => {
    // 在捕获阶段接：焦点在终端里的时候，这个键不能先被终端当成输入
    const onKey = (event: KeyboardEvent) => {
      if (!isToggleKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      toggleSide()
    }
    document.addEventListener('keydown', onKey, true)
    // 在桌面外壳里，应用菜单上也有这一项
    const offMenu = window.litchShell?.onMenu?.((action) => {
      if (action === 'side.toggle') toggleSide()
    })
    return () => {
      document.removeEventListener('keydown', onKey, true)
      offMenu?.()
    }
  }, [])

  return loaded ? (
    <Suspense fallback={null}>
      <SidePanel place={place} available={page === null} startedOpen={startedOpen.current} />
    </Suspense>
  ) : null
}

/** 标题栏右边开合侧面板的按钮 */
export function SideToggle() {
  const t = useT()
  const { open } = useSide()
  return (
    <button
      type="button"
      className="ibtn tb-side"
      title={t('side.toggle')}
      aria-label={t('side.toggle')}
      aria-pressed={open}
      onClick={toggleSide}
    >
      <Icon name="side" />
    </button>
  )
}
