// 侧面板接进应用的那一小段：面板挂在哪（眼前的会话在哪台设备的哪个工作区）、开合的快捷键和应用菜单，
// 以及标题栏上的开合按钮。应用外壳（App.tsx、TitleBar.tsx）里只放这两个组件。
import { keys, type SessionSummary, type WorkspaceView } from '@litch/core'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Draft, Selection } from '../app/App.tsx'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { dismissToast, showToast } from '../app/toasts.tsx'
import { ownerKey } from './browser/bridge.ts'
import { BROWSER_TAB, onPendingShow, setViewing } from './browser/store.ts'
import { setSideView, showSideTab, toggleSide, useSide, viewKey } from './side.ts'
import type { SidePlace } from './tabs.ts'

// 面板第一次打开之前，它不在启动要读的那一包里
const SidePanel = lazy(() =>
  import('./SidePanel.tsx').then((module) => ({ default: module.SidePanel })),
)

const NO_ROOTS: readonly string[] = []

/**
 * 面板跟着眼前的会话走：会话在哪个工作区，面板里就是那个工作区；不属于工作区的会话，用它的工作目录；
 * 在设备层工作树里的会话，根是那棵工作树（文件、终端、差异都看它，不看源仓库）；
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
  const tree = draft ? null : (summary?.worktree ?? null)
  const roots =
    tree && tree.state !== 'removed'
      ? [tree.path]
      : workspace
        ? workspace.roots
        : !draft && cwd
          ? [cwd]
          : NO_ROOTS
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
  // 面板开没开按会话记：眼前换了会话，先换成那个会话自己的开合（在别的效果之前，浏览器的 show 要在它上面打开）
  const view =
    page !== null
      ? ''
      : selection
        ? viewKey(selection.deviceId, selection.sessionId)
        : draft
          ? viewKey(draft.deviceId, null)
          : ''
  useLayoutEffect(() => setSideView(view), [view])
  const { open, raised } = useSide()
  /** 这之前人打开过几次面板：之后又打开了才抢焦点 */
  const startedOpen = useRef(raised)
  /** 面板打开过没有：打开过就一直留在页面里，收起只是不显示 */
  const [loaded, setLoaded] = useState(open)
  useEffect(() => {
    if (open) setLoaded(true)
  }, [open])

  useShowRouting(selection, draft, page)

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

/** 浏览器 show 留在别的会话上的提示的标识 */
const showToastId = (key: string) => `browser-show:${key}`

/**
 * 代理调 show 要给人看网页（browser/store.ts）：告诉浏览器的状态眼前看着的是哪个会话（侧面板显示不出来的页面上是没有，
 * 新建对话页上是那台设备上还没建的会话），
 * 切到一个有网页等着看的会话时打开面板换到浏览器标签；网页记在了别的会话名下时出一条提示，点“去看”切过去
 */
function useShowRouting(
  selection: Selection | null,
  draft: Draft | null,
  page: string | null,
): void {
  const { replica } = useServices()
  // 和浏览器标签认的会话一样：新建对话页上是那台设备、会话标识为空
  const deviceId = page === null ? (selection?.deviceId ?? draft?.deviceId ?? null) : null
  const sessionId = selection?.sessionId ?? ''
  useEffect(() => {
    const owner = deviceId === null ? null : { deviceId, threadId: sessionId }
    if (setViewing(owner) && owner) {
      showSideTab(BROWSER_TAB)
      dismissToast(showToastId(ownerKey(owner)))
    }
  }, [deviceId, sessionId])

  useEffect(
    () =>
      onPendingShow((tab) => {
        const { deviceId: device, threadId } = tab.owner
        // 侧栏里折着、没画出来的会话界面这边没有它的摘要：不写标题
        const summary = replica.store.get<SessionSummary>(keys.summary(device, threadId))
        showToast({
          id: showToastId(ownerKey(tab.owner)),
          lifeMs: 10_000,
          text: (t) =>
            summary
              ? t('browser.showElsewhere', { title: t.text(summary.title) })
              : t('browser.showElsewhereUntitled'),
          action: {
            label: (t) => t('browser.showGo'),
            run: () => requestOpenSession({ deviceId: device, sessionId: threadId }),
          },
        })
      }),
    [replica],
  )
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
