// 侧栏顶上的“更多”：不常用的开关放这里，免得侧栏顶上一排按钮。
// 平时是筛选右边一个“···”按钮，点开是一份菜单，开关点一下就换、菜单不收，好接着点。
// 两项：永远显示活动对话（只看某几个 harness 时，在跑、没看过、等人的会话照样列出，默认开）；
// 显不显示别的应用派出来的会话（Claude 桌面端起的 Claude Code 子会话）。
// 开关记在界面本地（state.ts）；树里怎么跟着藏在 Sidebar.tsx。
import { useT } from '../app/appearance.ts'
import { Check, More } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import {
  setSidebarNativeChildren,
  setSidebarShowActive,
  useSidebarNativeChildren,
  useSidebarShowActive,
} from './state.ts'

export function SidebarMore() {
  const t = useT()
  const nativeChildren = useSidebarNativeChildren()
  const showActive = useSidebarShowActive()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  return (
    <div className="sb-more" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        title={t('sidebar.more')}
        aria-label={t('sidebar.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop down" ref={pop} onKeyDown={onKeyDown}>
          <div role="menu" aria-label={t('sidebar.more')} className="pick-list">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={showActive}
              className="pick-opt"
              data-option="showActive"
              onClick={() => setSidebarShowActive(!showActive)}
            >
              <b>
                <span className="pick-mark">{showActive ? <Check /> : null}</span>
                {t('sidebar.more.showActive')}
              </b>
              <span>{t('sidebar.more.showActive.note')}</span>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={nativeChildren}
              className="pick-opt"
              data-option="nativeChildren"
              onClick={() => setSidebarNativeChildren(!nativeChildren)}
            >
              <b>
                <span className="pick-mark">{nativeChildren ? <Check /> : null}</span>
                {t('sidebar.more.nativeChildren')}
              </b>
              <span>{t('sidebar.more.nativeChildren.note')}</span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
