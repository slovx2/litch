// 侧栏这个框：开合、拖右边沿调宽度、开合的快捷键和应用菜单，以及标题栏上的开合按钮。
// 框里面是什么它不管（Sidebar.tsx 把内容交进来）：拖动、开合时只有这个框重画，里面的设备和会话不跟着重画。
// 应用外壳里（TitleBar.tsx）只挂 SidebarToggle 一个组件。
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { useT } from '../app/appearance.ts'
import { Icon, Plus } from '../app/icons.tsx'
import {
  drawnWidth,
  SIDEBAR_MIN,
  setSidebarWidth,
  sidebarNow,
  toggleSidebar,
  useSidebar,
  widthCss,
  widthLimit,
} from './state.ts'

/**
 * 是不是开合侧栏的那个键：Cmd/Ctrl+Shift+B。按键位认。
 * 不用不带 Shift 的那个：Linux 和 Windows 上 Ctrl+B 是终端里常用的键（tmux 的前缀、行编辑里退一格）
 */
const isToggleKey = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'KeyB'

const onResize = (listener: () => void) => {
  window.addEventListener('resize', listener)
  return () => window.removeEventListener('resize', listener)
}

/** 右边沿那一条：能拖，也能用方向键挪。窗口多宽只有它要知道（报给读屏：现在多宽、最宽能到多少） */
function Grip({ panel }: { panel: RefObject<HTMLElement | null> }) {
  const t = useT()
  const { width } = useSidebar()
  const room = useSyncExternalStore(onResize, () => window.innerWidth)

  // 侧栏靠左，往右拖是变宽。从眼下画出来的宽度算起：窗口窄的时候它比记着的那个数小
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    const startX = event.clientX
    const startWidth = panel.current?.offsetWidth ?? width
    grip.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) =>
      setSidebarWidth(drawnWidth(startWidth + (moved.clientX - startX), window.innerWidth))
    const stop = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', stop)
      grip.removeEventListener('pointercancel', stop)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', stop)
    grip.addEventListener('pointercancel', stop)
    event.preventDefault()
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: 这是一条能拖、也能用方向键挪的分隔条，hr 做不了
    <div
      className="sb-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-valuenow={drawnWidth(width, room)}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={widthLimit(room)}
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -24, ArrowRight: 24 }[event.key]
        if (!step) return
        event.preventDefault()
        // 用现在的宽度：连着按得快的时候，画的那一刻记下的宽度可能已经旧了
        const shown = drawnWidth(sidebarNow().width, window.innerWidth)
        setSidebarWidth(drawnWidth(shown + step, window.innerWidth))
      }}
    />
  )
}

export function SidebarFrame({ label, children }: { label: string; children: ReactNode }) {
  const { open, width } = useSidebar()
  const root = useRef<HTMLElement>(null)

  useEffect(() => {
    // 在捕获阶段接：焦点在终端里的时候，这个键不能先被终端当成输入
    const onKey = (event: KeyboardEvent) => {
      if (!isToggleKey(event)) return
      event.preventDefault()
      event.stopPropagation()
      toggleSidebar()
    }
    document.addEventListener('keydown', onKey, true)
    // 在桌面外壳里，应用菜单上也有这一项
    const offMenu = window.litchShell?.onMenu?.((action) => {
      if (action === 'sidebar.toggle') toggleSidebar()
    })
    return () => {
      document.removeEventListener('keydown', onKey, true)
      offMenu?.()
    }
  }, [])

  return (
    <>
      {/* 收起只是不显示：里面展开了哪些、露出了多少都还在，订阅也不断 */}
      <aside
        ref={root}
        className="sb"
        aria-label={label}
        hidden={!open}
        style={{ width: widthCss(width) }}
      >
        {children}
      </aside>
      {open ? <Grip panel={root} /> : null}
    </>
  )
}

/**
 * 标题栏左边开合侧栏的按钮。侧栏收着的时候旁边多一个“新对话”：
 * 侧栏里那个入口这时看不见，新建还得有地方点（另有 Cmd/Ctrl+N）
 */
export function SidebarToggle({ onCompose }: { onCompose(): void }) {
  const t = useT()
  const { open } = useSidebar()
  return (
    <>
      <button
        type="button"
        className="ibtn tb-sidebar"
        title={t('sidebar.toggle')}
        aria-label={t('sidebar.toggle')}
        aria-pressed={open}
        onClick={toggleSidebar}
      >
        <Icon name="sidebar" />
      </button>
      {open ? null : (
        <button
          type="button"
          className="ibtn tb-new"
          title={t('sidebar.newSession')}
          aria-label={t('sidebar.newSession')}
          onClick={onCompose}
        >
          <Plus />
        </button>
      )}
    </>
  )
}
