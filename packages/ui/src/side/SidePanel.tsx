// 主区右边的侧面板：一个带标签页的框，里面是什么由标签登记表（tabs.ts）定。
// 这里只管框架：开合、拖宽、标签栏、窗口窄的时候怎么让位（一直和对话并排，两边一起让，见 side.ts 的 layoutOf）。
import { type DeviceView, keys, type SessionMeta } from '@litch/core'
import {
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { Close, Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import {
  clampWidth,
  layoutOf,
  SIDE_MIN,
  setSideOpen,
  setSideTab,
  setSideWidth,
  sideNow,
  useSide,
} from './side.ts'
import { SIDE_TABS, type SidePlace } from './tabs.ts'

/** 面板所在的那一行一共多宽（对话加面板；侧栏不在这一行里）。面板靠它决定自己画多宽 */
function useRoom(panel: { current: HTMLElement | null }): number {
  const [room, setRoom] = useState(0)
  useLayoutEffect(() => {
    const body = panel.current?.parentElement
    if (!body) return
    const measure = () => setRoom(body.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [panel])
  return room
}

export function SidePanel({
  place,
  available,
  startedOpen,
}: {
  /** 面板挂在哪。null：眼前没有会话，也没在写新会话 */
  place: SidePlace | null
  /** 这一页有没有侧面板。“设备”“已归档对话”这类页面没有：面板不显示，回到对话时原样回来 */
  available: boolean
  /** 应用启动时人打开面板的次数（side.ts 的 raised）：比它多了才是人在这之后打开的，才抢焦点 */
  startedOpen: number
}) {
  const side = useSide()
  const t = useT()
  const root = useRef<HTMLElement>(null)
  const room = useRoom(root)
  const device = useKey<DeviceView>(keys.device(place?.deviceId ?? ''))
  const layout = layoutOf(side.width, room)
  const visible = side.open && available
  // 要眼前会话的 harness 会某件事才出的标签（目标）：不会的、没有会话的不出，开着它时切过来就显示第一页
  const meta = useKey<SessionMeta>(
    place?.sessionId ? keys.session(place.deviceId, place.sessionId) : '',
  )
  const tabs = SIDE_TABS.filter((tab) => !tab.needs || meta?.can[tab.needs] === true)
  const spec = tabs.find((tab) => tab.id === side.tab) ?? tabs[0] ?? SIDE_TABS[0]

  // 面板是人打开的：焦点进面板里（标签的内容自己标出该落在哪），键盘接着就能用。
  // 切到一个面板开着的会话不算，不抢焦点
  const seen = useRef(startedOpen)
  useEffect(() => {
    const opened = side.open && side.raised !== seen.current
    seen.current = side.raised
    if (!opened || !available) return
    // 内容可能这一刻才装载：等两帧再找
    let frames = 2
    let handle = 0
    const seek = () => {
      const target = root.current?.querySelector<HTMLElement>('[data-side-focus]')
      if (target) target.focus({ preventScroll: true })
      else if (frames-- > 0) handle = requestAnimationFrame(seek)
    }
    handle = requestAnimationFrame(seek)
    return () => cancelAnimationFrame(handle)
  }, [side.open, side.raised, available])

  // 拖左边那条调宽度。面板靠右，往左拖是变宽
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const grip = event.currentTarget
    const startX = event.clientX
    const startWidth = root.current?.offsetWidth ?? side.width
    grip.setPointerCapture(event.pointerId)
    const move = (moved: PointerEvent) =>
      setSideWidth(clampWidth(startWidth + (startX - moved.clientX), room))
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
    <aside
      ref={root}
      className="side"
      hidden={!visible}
      aria-label={t('side.panel')}
      data-mode={layout.mode}
      data-device={place?.deviceId ?? ''}
      data-workspace={place?.workspaceId ?? ''}
      style={{ ...wireStyle(device?.wire), width: layout.width }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 这是一条能拖、也能用方向键挪的分隔条，hr 做不了 */}
      <div
        className="side-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('side.resize')}
        aria-valuenow={layout.width}
        aria-valuemin={SIDE_MIN}
        tabIndex={0}
        onPointerDown={drag}
        onKeyDown={(event) => {
          const step = { ArrowLeft: 24, ArrowRight: -24 }[event.key]
          if (!step) return
          event.preventDefault()
          // 用现在的宽度：连着按得快的时候，画的那一刻记下的宽度可能已经旧了
          setSideWidth(clampWidth(Math.min(sideNow().width, layout.width) + step, room))
        }}
      />
      <div className="side-tabs">
        <div className="side-tablist" role="tablist" aria-label={t('side.tabs')}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              className="side-tab"
              data-tab={tab.id}
              title={t(tab.label)}
              aria-label={t(tab.label)}
              aria-selected={tab.id === spec?.id}
              onClick={() => setSideTab(tab.id)}
            >
              <Icon name={tab.icon} small />
              <span className="ell">{t(tab.label)}</span>
              {tab.Badge && place ? (
                <Suspense fallback={null}>
                  <tab.Badge place={place} />
                </Suspense>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="ibtn"
          data-tool="hide"
          title={t('side.hide')}
          aria-label={t('side.hide')}
          onClick={() => setSideOpen(false)}
        >
          <Close />
        </button>
      </div>
      <div className="side-body" role="tabpanel" data-tab={spec?.id}>
        {place && spec ? (
          <Suspense fallback={null}>
            <spec.Panel place={place} shown={visible} />
          </Suspense>
        ) : (
          <div className="side-none dim">{t('side.none')}</div>
        )}
      </div>
    </aside>
  )
}
