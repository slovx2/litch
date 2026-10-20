// 侧面板里的“浏览器”标签：上面一排网页标签，下面工具栏（后退、前进、刷新、地址栏、在系统浏览器打开），
// 再下面是放网页的那块矩形。网页不在界面里，由桌面外壳叠在这块矩形上（place.ts）；
// 普通浏览器里没有外壳，只显示一句说明。标签按会话分开：眼前的会话是哪个，就显示它的网页
// （代理开的和用户自己开的都在，代理开的有记号）。
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Back, Close, Forward, Icon, Plus, Stop } from '../../app/icons.tsx'
import { useBrowserImport } from '../../settings/BrowserImportEntry.tsx'
import type { SideTabProps } from '../tabs.ts'
import { type BrowserBridge, type BrowserTabInfo, browserBridge, ownerKey } from './bridge.ts'
import { usePlacement } from './place.ts'
import { SavePrompt } from './SavePrompt.tsx'
import { SignInCard } from './SignInCard.tsx'
import { chooseBrowserTab, chooseTab, tabsOf, useBrowserState } from './store.ts'
import './browser.css'

export function BrowserTab({ place, shown }: SideTabProps) {
  const t = useT()
  const bridge = browserBridge()
  if (!bridge) return <div className="side-none dim bw-only">{t('browser.desktopOnly')}</div>
  return <BrowserPane bridge={bridge} place={place} shown={shown} />
}

/** 标签上显示的字 */
const labelOf = (tab: BrowserTabInfo, blank: string) =>
  tab.title.trim() || (tab.url === 'about:blank' ? blank : tab.url)

/** 地址栏里显示的：空白页显示成空的 */
const shownUrl = (tab: BrowserTabInfo | undefined) =>
  !tab || tab.url === 'about:blank' ? '' : tab.url

function BrowserPane({
  bridge,
  place,
  shown,
}: SideTabProps & {
  bridge: BrowserBridge
}) {
  const t = useT()
  const owner = useMemo(
    () => ({ deviceId: place.deviceId, threadId: place.sessionId ?? '' }),
    [place.deviceId, place.sessionId],
  )
  const key = ownerKey(owner)
  const { tabs, chosen, wanted } = useBrowserState()
  const mine = useMemo(() => tabsOf(tabs, owner), [tabs, owner])
  const currentId = chooseTab(mine, chosen[key], wanted[key])
  const current = mine.find((tab) => tab.id === currentId)
  const view = useRef<HTMLDivElement>(null)
  // 从别的浏览器导入：工具栏上的菜单、工具栏下面的横幅、对话框
  const imports = useBrowserImport(bridge)
  usePlacement(bridge, shown ? (currentId ?? null) : null, view)

  // 地址栏：没在改的时候跟着网页走，正在改的时候不被网页的跳转冲掉
  const [draft, setDraft] = useState(shownUrl(current))
  const [editing, setEditing] = useState(false)
  const showing = shownUrl(current)
  useEffect(() => {
    if (!editing) setDraft(showing)
  }, [editing, showing])

  const go = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (text === '') return
    setEditing(false)
    if (current) bridge.navigate(current.id, text)
    else
      void bridge.open(owner, text).then((tab) => {
        if (tab) chooseBrowserTab(owner, tab.id)
      })
  }
  const newTab = () =>
    void bridge.open(owner, '').then((tab) => {
      if (tab) chooseBrowserTab(owner, tab.id)
    })

  return (
    <div className="bw" data-agent={current?.agentActive ? 'true' : undefined}>
      <div className="bw-tabs" role="tablist" aria-label={t('browser.tabs')}>
        {mine.map((tab) => (
          <div
            key={tab.id}
            className="bw-tab"
            data-active={tab.id === currentId}
            data-kind={tab.kind}
            data-agent={tab.agentActive ? 'true' : undefined}
            title={`${labelOf(tab, t('browser.untitled'))}\n${tab.url}`}
          >
            <button
              type="button"
              role="tab"
              className="bw-tab-btn"
              aria-selected={tab.id === currentId}
              onClick={() => chooseBrowserTab(owner, tab.id)}
            >
              {tab.kind === 'agent' && (
                <span
                  className="bw-mark"
                  title={tab.keep ? t('browser.kept') : t('browser.agentTab')}
                >
                  <span className="bw-sr">
                    {tab.keep ? t('browser.kept') : t('browser.agentTab')}
                  </span>
                </span>
              )}
              <span className="bw-tab-name">{labelOf(tab, t('browser.untitled'))}</span>
              {tab.agentActive && <span className="bw-busy">{t('browser.agent')}</span>}
            </button>
            <button
              type="button"
              className="ibtn"
              title={t('browser.closeTab')}
              aria-label={t('browser.closeTab')}
              onClick={() => bridge.close(tab.id)}
            >
              <Close />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="ibtn bw-new"
          title={t('browser.newTab')}
          aria-label={t('browser.newTab')}
          onClick={newTab}
        >
          <Plus />
        </button>
      </div>
      <form className="bw-bar" onSubmit={go}>
        <button
          type="button"
          className="ibtn"
          title={t('browser.back')}
          aria-label={t('browser.back')}
          disabled={!current?.canGoBack}
          onClick={() => current && bridge.navigate(current.id, 'back')}
        >
          <Back />
        </button>
        <button
          type="button"
          className="ibtn"
          title={t('browser.forward')}
          aria-label={t('browser.forward')}
          disabled={!current?.canGoForward}
          onClick={() => current && bridge.navigate(current.id, 'forward')}
        >
          <Forward />
        </button>
        <button
          type="button"
          className="ibtn"
          title={current?.loading ? t('browser.stop') : t('browser.reload')}
          aria-label={current?.loading ? t('browser.stop') : t('browser.reload')}
          disabled={!current}
          onClick={() =>
            current && bridge.navigate(current.id, current.loading ? 'stop' : 'reload')
          }
        >
          {current?.loading ? <Stop /> : <Icon name="reload" />}
        </button>
        <input
          className="bw-address"
          data-side-focus
          value={draft}
          placeholder={t('browser.address')}
          aria-label={t('browser.address')}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => {
            setEditing(true)
            event.currentTarget.select()
          }}
          onBlur={() => setEditing(false)}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            setDraft(shownUrl(current))
            event.currentTarget.blur()
          }}
        />
        <button
          type="button"
          className="ibtn"
          title={t('browser.external')}
          aria-label={t('browser.external')}
          disabled={!current || !/^https?:/.test(current.url)}
          onClick={() => current && bridge.openExternal(current.id)}
        >
          <ExternalGlyph />
        </button>
        {imports.menu}
      </form>
      {imports.banner}
      {current?.agentActive && <div className="bw-agent-bar">{t('browser.agentBar')}</div>}
      <SignInCard bridge={bridge} owner={owner} currentTabId={currentId ?? null} />
      <SavePrompt bridge={bridge} owner={owner} />
      <div className="bw-view" ref={view}>
        {!current && <div className="bw-empty dim">{t('browser.empty')}</div>}
      </div>
      {imports.dialog}
    </div>
  )
}

/** 在系统浏览器打开：一个框，右上角伸出一支箭头 */
function ExternalGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M9.5 3.5h3v3M12.5 3.5L7.5 8.5M11 9.5v3H3.5V5H7" />
    </svg>
  )
}
