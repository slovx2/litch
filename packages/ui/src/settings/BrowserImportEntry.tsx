// “从浏览器导入”的三个入口：设置页“内置浏览器”一组里的一行，浏览器面板工具栏上的菜单
// （“导入 Cookie 和密码…”），浏览器面板顶上的横幅（从没导过、没关过才出，关了不再出）。
// 三处打开的都是同一个对话框（BrowserImportDialog.tsx）。没有外壳、外壳的主进程还没有导入接口时都不出。
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { More } from '../app/icons.tsx'
import { usePopover } from '../app/popover.ts'
import type { BrowserBridge, BrowserImportBridge, ImportState } from '../side/browser/bridge.ts'
import { BrowserImportDialog } from './BrowserImportDialog.tsx'
import { showBanner } from './browser-import-logic.ts'
import { dayOf } from './tools-logic.ts'

/** 导过没有、横幅关过没有。取不到当 null（横幅不出） */
function useImportState(bridge: BrowserImportBridge | undefined) {
  const [state, setState] = useState<ImportState | null>(null)
  const refresh = useCallback(() => {
    if (!bridge) return () => {}
    let live = true
    bridge.state().then(
      (next) => {
        if (live) setState(next)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [bridge])
  useEffect(() => refresh(), [refresh])
  return { state, setState, refresh }
}

/** 设置页“内置浏览器”一组里的“从浏览器导入”一行 */
export function BrowserImportRow({ bridge }: { bridge: BrowserBridge }) {
  const t = useT()
  const imports = bridge.import
  const { state, refresh } = useImportState(imports)
  const [open, setOpen] = useState(false)
  if (!imports) return null
  return (
    <section className="set-block" data-browser-import={state?.lastImportAt ? 'done' : 'never'}>
      <h3>{t('bimport.entry.title')}</h3>
      <div className="set-rows">
        <div className="set-row">
          <div className="set-switch-text">
            <span className="set-note">{t('bimport.entry.note')}</span>
            {state?.lastImportAt ? (
              <span className="set-note" data-last-import>
                {t('bimport.entry.last', { day: dayOf(state.lastImportAt) })}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="btn"
            data-act="browser-import"
            onClick={() => setOpen(true)}
          >
            {t('bimport.entry.button')}
          </button>
        </div>
      </div>
      {open ? (
        <BrowserImportDialog
          bridge={imports}
          onClose={() => {
            setOpen(false)
            refresh()
          }}
        />
      ) : null}
    </section>
  )
}

/**
 * 浏览器面板上的两个入口和它们打开的对话框：menu 放在工具栏上，banner 放在工具栏下面（占着位置、
 * 不盖在网页上），dialog 随便放在面板里（模态的，打开时网页由 place.ts 撤下）。没有导入接口时都是 null
 */
export function useBrowserImport(bridge: BrowserBridge): {
  menu: ReactNode
  banner: ReactNode
  dialog: ReactNode
} {
  const imports = bridge.import
  const { state, setState, refresh } = useImportState(imports)
  const [open, setOpen] = useState(false)
  if (!imports) return { menu: null, banner: null, dialog: null }
  const later = () => {
    // 先在这边收起来，不等主进程
    setState({ ...(state ?? {}), bannerDismissedAt: Date.now() })
    void imports.dismissBanner().catch(() => {})
  }
  return {
    menu: <BrowserMenu onImport={() => setOpen(true)} />,
    banner: showBanner(state) ? (
      <ImportBanner onImport={() => setOpen(true)} onLater={later} />
    ) : null,
    dialog: open ? (
      <BrowserImportDialog
        bridge={imports}
        onClose={() => {
          setOpen(false)
          refresh()
        }}
      />
    ) : null,
  }
}

/** 工具栏最右边的“···”：浏览器的菜单 */
function BrowserMenu({ onImport }: { onImport(): void }) {
  const t = useT()
  const { open, setOpen, root, trigger, pop, onKeyDown } = usePopover()
  return (
    <div className="bimp-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ibtn"
        title={t('bimport.menu')}
        aria-label={t('bimport.menu')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-act="browser-menu"
        onClick={() => setOpen(!open)}
      >
        <More />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: 键盘事件是从里面的按钮冒上来的
        <div className="pick-pop down" ref={pop} onKeyDown={onKeyDown}>
          <div role="menu" aria-label={t('bimport.menu')} className="pick-list">
            <button
              type="button"
              role="menuitem"
              className="pick-opt"
              data-act="browser-import"
              onClick={() => {
                setOpen(false)
                onImport()
              }}
            >
              <b>{t('bimport.menu.import')}</b>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ImportBanner({ onImport, onLater }: { onImport(): void; onLater(): void }) {
  const t = useT()
  return (
    <div className="bimp-banner" data-browser-import-banner>
      <span className="bimp-banner-text">{t('bimport.banner')}</span>
      <button
        type="button"
        className="btn primary mini"
        data-act="banner-import"
        onClick={onImport}
      >
        {t('bimport.banner.import')}
      </button>
      <button type="button" className="btn ghost mini" data-act="banner-later" onClick={onLater}>
        {t('bimport.banner.later')}
      </button>
    </div>
  )
}
