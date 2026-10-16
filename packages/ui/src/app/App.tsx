import { keys, type SessionSummary } from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchivedPage } from '../archived/ArchivedPage.tsx'
import { ArchivedSession } from '../archived/ArchivedSession.tsx'
import { NewSession } from '../composer/NewSession.tsx'
import type { PlaceWish } from '../composer/new-place.ts'
import { useNewPlace } from '../composer/useNewPlace.ts'
import { DevicesPage } from '../devices/DevicesPage.tsx'
import { SettingsPage, type SettingsSection } from '../settings/SettingsPage.tsx'
import { SideSlot } from '../side/SideSlot.tsx'
import { Sidebar } from '../sidebar/Sidebar.tsx'
import { TerminalSlot } from '../terminal/TerminalSlot.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import { onNewSessionRequest } from './actions.ts'
import { useKey, useServices } from './services.tsx'
import { TitleBar } from './TitleBar.tsx'
import { Toasts } from './toasts.tsx'

/** 占着对话区的那几页：已归档对话、设备、设置 */
export type Page = 'archived' | 'devices' | 'settings'

export interface Selection {
  deviceId: string
  sessionId: string
}

/** 正在写第一条消息、还没建出来的会话。workspaceId 为 null 表示不属于任何工作区 */
export interface Draft {
  deviceId: string
  workspaceId: string | null
}

export function App() {
  const { channel, replica } = useServices()
  /** 选中的会话。启动时不选：没有选中会话的时候，主区域就是新建对话页 */
  const [picked, setPicked] = useState<Selection | null>(null)
  /**
   * 新建对话页上明说的去处：从侧栏工作区行的加号带过来的，或者在页上自己换的。
   * null：按默认的来（上次用的设备和工作区）
   */
  const [wish, setWish] = useState<PlaceWish | null>(null)
  const place = useNewPlace(wish)
  /** 正开着的那一页：已归档对话、设备，或者设置。选一个会话或者开始写新会话就离开它 */
  const [page, setPage] = useState<Page | null>(null)
  /** 设置页上正看着哪一组。记在这里：应用菜单的“关于”要能直接开到那一组 */
  const [settingsAt, setSettingsAt] = useState<SettingsSection>('look')
  /** 在“已归档对话”那一页里正只读地看着的那个对话 */
  const [peek, setPeek] = useState<Selection | null>(null)
  // 选中的会话被归档或删掉了：回到新建对话页。
  // “没有摘要”不等于“没了”：刚建的会话，摘要可能比建好的应答晚一帧到，所以要见过之后又没了才算
  const pickedSummary = useKey<SessionSummary>(
    keys.summary(picked?.deviceId ?? '', picked?.sessionId ?? ''),
  )
  const seen = useRef<Selection | null>(null)
  useEffect(() => {
    if (!picked) return
    if (pickedSummary) seen.current = picked
    else if (seen.current === picked) setPicked(null)
  }, [picked, pickedSummary])
  /** 正在写的新会话要建在哪。选中了会话就没有它；一台设备都没有的时候也是 null */
  const draft: Draft | null = picked ? null : place
  // 开着某一页的时候，侧栏里没有哪个会话是选中的
  const selection = page ? null : picked

  // 打开一个会话就算读过了
  useEffect(() => {
    if (!selection) return
    const { deviceId, sessionId } = selection
    const summary = replica.store.get<SessionSummary>(keys.summary(deviceId, sessionId))
    if (summary?.unread)
      channel.command('session.markRead', { deviceId, sessionId }).catch(() => {})
  }, [selection, channel, replica])

  const openPage = useCallback((next: Page | null) => {
    setPage(next)
    setPeek(null)
  }, [])
  const select = useCallback(
    (next: Selection) => {
      setPicked(next)
      setWish(null)
      openPage(null)
    },
    [openPage],
  )
  /** 到新建对话页去。next 是明说要建在哪；null 是按默认的来 */
  const compose = useCallback(
    (next: PlaceWish | null) => {
      setPicked(null)
      setWish(next)
      openPage(null)
    },
    [openPage],
  )
  const closePage = useCallback(() => openPage(null), [openPage])
  const openDevices = useCallback(() => openPage('devices'), [openPage])
  const closePeek = useCallback(() => setPeek(null), [])

  /** 开一个新对话：建在眼前这个会话所在的工作区里；眼前没有会话就按默认的来 */
  const startNew = useCallback(() => {
    if (!picked) return compose(null)
    const { deviceId, sessionId } = picked
    const summary = replica.store.get<SessionSummary>(keys.summary(deviceId, sessionId))
    compose({ deviceId, workspaceId: summary?.workspaceId ?? null })
  }, [picked, replica, compose])

  // 设置页的三个入口：侧栏底部那一项（走 openPage）、Cmd/Ctrl+逗号、应用菜单里的“设置…”和“关于”。
  // 在桌面外壳里这个键是菜单的加速键，按了走的是菜单那条路；页面自己也认它，在普通浏览器里一样能用
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key !== ',') return
      event.preventDefault()
      openPage('settings')
    }
    document.addEventListener('keydown', onKey)
    const offMenu = window.litchShell?.onMenu?.((action) => {
      if (action !== 'settings.open' && action !== 'settings.about') return
      if (action === 'settings.about') setSettingsAt('about')
      openPage('settings')
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      offMenu?.()
    }
  }, [openPage])

  // Cmd/Ctrl+N，和输入框里的 /new，是同一件事
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      startNew()
    }
    document.addEventListener('keydown', onKey)
    const off = onNewSessionRequest(startNew)
    return () => {
      document.removeEventListener('keydown', onKey)
      off()
    }
  }, [startNew])

  // 文件拖到输入区以外的地方：不收，也不让浏览器把页面换成那个文件
  useEffect(() => {
    const refuse = (event: DragEvent) => {
      const data = event.dataTransfer
      if (!data || !Array.from(data.types).includes('Files') || event.defaultPrevented) return
      event.preventDefault()
      data.dropEffect = 'none'
    }
    window.addEventListener('dragover', refuse)
    window.addEventListener('drop', refuse)
    return () => {
      window.removeEventListener('dragover', refuse)
      window.removeEventListener('drop', refuse)
    }
  }, [])

  return (
    <div className="app">
      <TitleBar selection={selection} draft={draft} page={page} peek={peek} onCompose={compose} />
      {/* 侧栏和右边那一块（对话加侧面板）并排，各占一栏：侧栏变宽变窄、收起，右边那一块的宽度跟着变 */}
      <Sidebar
        selection={selection}
        draft={page ? null : draft}
        page={page}
        onSelect={select}
        onCompose={compose}
        onPage={openPage}
      />
      <div className="body">
        <main className="main">
          <Toasts />
          {page === 'archived' && peek ? (
            <ArchivedSession
              key={`${peek.deviceId}:${peek.sessionId}`}
              {...peek}
              onBack={closePeek}
              onRestored={select}
            />
          ) : page === 'archived' ? (
            <ArchivedPage onClose={closePage} onOpen={setPeek} />
          ) : page === 'devices' ? (
            <DevicesPage onClose={closePage} />
          ) : page === 'settings' ? (
            <SettingsPage
              section={settingsAt}
              onSection={setSettingsAt}
              onClose={closePage}
              onDevices={openDevices}
            />
          ) : selection ? (
            <Transcript
              onOpen={select}
              key={`${selection.deviceId}:${selection.sessionId}`}
              deviceId={selection.deviceId}
              sessionId={selection.sessionId}
            />
          ) : (
            <NewSession
              draft={draft}
              onPlace={setWish}
              onCreated={select}
              onDevices={openDevices}
            />
          )}
          {/* 终端面板一直在，收起只是不显示：里面的终端不跟着上面的内容换来换去 */}
          <TerminalSlot selection={selection} draft={draft} page={page} />
        </main>
        {/* 右边的侧面板（文件）：跟着眼前的会话走，收起只是不显示 */}
        <SideSlot selection={selection} draft={draft} page={page} />
      </div>
    </div>
  )
}
