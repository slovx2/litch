// 终端面板接进主区的那一小段：眼前这个会话算哪个工作区、开合的快捷键，和标题栏上的开合按钮。
import { keys, type SessionSummary } from '@litch/core'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Draft, Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { togglePanel, usePanel } from './panel.ts'
import type { TerminalPlace } from './TerminalPanel.tsx'

// 终端控件不小，用到的时候才装载：面板第一次打开之前，它不在启动要读的那一包里
const TerminalPanel = lazy(() =>
  import('./TerminalPanel.tsx').then((module) => ({ default: module.TerminalPanel })),
)

/**
 * 终端跟着眼前的会话走：会话在哪个工作区，面板里就是那个工作区的一组；新建对话页上看它要建在哪，
 * 在那一页上换设备、换工作区，面板跟着换。开着“设备”“已归档对话”这类页面时没有终端；
 * 一台设备都没有的时候也没有。
 */
function usePlace(
  selection: Selection | null,
  draft: Draft | null,
  page: string | null,
): TerminalPlace | null {
  const summary = useKey<SessionSummary>(
    keys.summary(selection?.deviceId ?? '', selection?.sessionId ?? ''),
  )
  if (page) return null
  if (draft) return { deviceId: draft.deviceId, workspaceId: draft.workspaceId }
  if (selection) {
    // 摘要还没到的那一帧先不动：不然面板会先闪到“无工作区”那一组
    return summary ? { deviceId: selection.deviceId, workspaceId: summary.workspaceId } : null
  }
  return null
}

/** 是不是开合终端的那个键：Ctrl+`。macOS 上也是 Ctrl，不是 Cmd（Cmd+` 是系统切窗口的） */
const isToggleKey = (event: KeyboardEvent): boolean =>
  event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === 'Backquote'

export function TerminalSlot({
  selection,
  draft,
  page,
}: {
  selection: Selection | null
  draft: Draft | null
  page: string | null
}) {
  const place = usePlace(selection, draft, page)
  const { open } = usePanel()
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
      togglePanel()
    }
    document.addEventListener('keydown', onKey, true)
    // 在桌面外壳里，应用菜单上也有这一项
    const offMenu = window.litchShell?.onMenu?.((action) => {
      if (action === 'terminal.toggle') togglePanel()
    })
    return () => {
      document.removeEventListener('keydown', onKey, true)
      offMenu?.()
    }
  }, [])

  return loaded ? (
    <Suspense fallback={null}>
      <TerminalPanel place={place} startedOpen={startedOpen.current} />
    </Suspense>
  ) : null
}

/** 标题栏右边开合终端的按钮 */
export function TerminalToggle() {
  const t = useT()
  const { open } = usePanel()
  return (
    <button
      type="button"
      className="ibtn tb-term"
      title={t('terminal.toggle')}
      aria-label={t('terminal.toggle')}
      aria-pressed={open}
      onClick={togglePanel}
    >
      <Icon name="term" />
    </button>
  )
}
