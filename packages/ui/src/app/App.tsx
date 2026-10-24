import { keys, type SessionSummary } from '@litch/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchivedPage } from '../archived/ArchivedPage.tsx'
import { ArchivedSession } from '../archived/ArchivedSession.tsx'
import { ConfigAgent } from '../assist/ConfigAgent.tsx'
import { nextAssistSeq } from '../assist/useAssistant.ts'
import { NewSession } from '../composer/NewSession.tsx'
import type { PlaceWish } from '../composer/new-place.ts'
import { useNewPlace } from '../composer/useNewPlace.ts'
import { DevicesPage } from '../devices/DevicesPage.tsx'
import { Onboarding } from '../onboarding/Onboarding.tsx'
import { InfoRail } from '../rail/InfoRail.tsx'
import { isSettingsSection, SettingsPage, type SettingsSection } from '../settings/SettingsPage.tsx'
import { useUpdateToast } from '../settings/UpdateBlock.tsx'
import { SideSlot } from '../side/SideSlot.tsx'
import { Sidebar } from '../sidebar/Sidebar.tsx'
import { TaskNotices } from '../tasks/TaskNotices.tsx'
import { TasksPage } from '../tasks/TasksPage.tsx'
import { TerminalSlot } from '../terminal/TerminalSlot.tsx'
import { Transcript } from '../transcript/Transcript.tsx'
import {
  type DeviceSection,
  onAssistantRequest,
  onDeviceRequest,
  onNewSessionRequest,
  onOpenSessionRequest,
  onSettingsRequest,
  onTasksRequest,
  type TasksRoute,
} from './actions.ts'
import { LeaveGuardHost, leaveThen } from './leave-guard.tsx'
import { readWhileOpen } from './read.ts'
import { useKey, useServices } from './services.tsx'
import { TitleBar } from './TitleBar.tsx'
import { Toasts } from './toasts.tsx'

/** 占着对话区的那几页：已归档对话、设备、设置、定时任务 */
export type Page = 'archived' | 'devices' | 'settings' | 'tasks'

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
  useUpdateToast()
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

  // 开着一个会话就算读过了：摘要上的未读一出现就清（摘要比选中晚到的也算）
  useEffect(() => {
    if (!selection) return
    return readWhileOpen(channel, replica.store, selection.deviceId, selection.sessionId)
  }, [selection, channel, replica])

  // 换页的动作都先过 leaveThen：眼前那一页有没保存的改动（harness 详情设置）时先问，问完了才换（leave-guard.tsx）
  const openPage = useCallback(
    (next: Page | null) =>
      leaveThen(() => {
        setPage(next)
        setPeek(null)
      }),
    [],
  )
  const select = useCallback(
    (next: Selection) =>
      leaveThen(() => {
        setPicked(next)
        setWish(null)
        openPage(null)
      }),
    [openPage],
  )
  /** 到新建对话页去。next 是明说要建在哪；null 是按默认的来 */
  const compose = useCallback(
    (next: PlaceWish | null) =>
      leaveThen(() => {
        setPicked(null)
        setWish(next)
        openPage(null)
      }),
    [openPage],
  )
  const closePage = useCallback(() => openPage(null), [openPage])
  /** 别处要求直接进哪台设备的详情。seq 每次都变，同一台再要一次也重新进 */
  const [deviceAt, setDeviceAt] = useState<{
    deviceId: string
    section: DeviceSection | null
    seq: number
  } | null>(null)
  const openDevices = useCallback(
    () =>
      leaveThen(() => {
        setDeviceAt(null)
        openPage('devices')
      }),
    [openPage],
  )
  const closePeek = useCallback(() => setPeek(null), [])
  /** 定时任务那一页一打开去哪。seq 每次都变：在那一页里再要一次也重新进 */
  const [tasksAt, setTasksAt] = useState<{ route: TasksRoute; seq: number }>({
    route: { view: 'list' },
    seq: 0,
  })
  const onPage = useCallback(
    (next: Page) =>
      leaveThen(() => {
        if (next === 'tasks') setTasksAt((was) => ({ route: { view: 'list' }, seq: was.seq + 1 }))
        openPage(next)
      }),
    [openPage],
  )
  // 别处要去定时任务的某个地方（会话顶上那一条的“去看任务”、会话菜单的“为这个会话建定时任务”）
  useEffect(
    () =>
      onTasksRequest((route: TasksRoute) =>
        leaveThen(() => {
          setTasksAt((was) => ({ route, seq: was.seq + 1 }))
          openPage('tasks')
        }),
      ),
    [openPage],
  )

  /** 开一个新对话：建在眼前这个会话所在的工作区里；眼前没有会话就按默认的来 */
  const startNew = useCallback(() => {
    if (!picked) return compose(null)
    const { deviceId, sessionId } = picked
    const summary = replica.store.get<SessionSummary>(keys.summary(deviceId, sessionId))
    compose({ deviceId, workspaceId: summary?.workspaceId ?? null })
  }, [picked, replica, compose])

  // 设置页的入口：侧栏底部的“设置”（走 openPage）、“外观”弹层里的“更多外观设置”（走 requestSettings）、Cmd/Ctrl+逗号、应用菜单里的“设置…”和“关于”。
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
      leaveThen(() => {
        if (action === 'settings.about') setSettingsAt('about')
        openPage('settings')
      })
    })
    // 别处要直接开到某一组（设备详情里 Computer Use 开关旁的“去设置里看看”）。
    // “设备”原来是设置里的一组，现在是设置页上直接进设备页的入口：要它就直接进设备页
    const offAsk = onSettingsRequest((section: string) =>
      leaveThen(() => {
        if (section === 'devices') return openDevices()
        if (isSettingsSection(section)) setSettingsAt(section)
        openPage('settings')
      }),
    )
    return () => {
      document.removeEventListener('keydown', onKey)
      offMenu?.()
      offAsk()
    }
  }, [openPage, openDevices])

  /** 最近一次点配置助手的序号（nextAssistSeq）：新建对话页看着它变了就往输入框里放好那一句，每个号只放一次 */
  const [assist, setAssist] = useState(0)
  // 配置助手（新建页标题下、设置页、首启引导）：到新建对话页，设备切到本机，harness 和模型照上次的不动
  useEffect(
    () =>
      onAssistantRequest(() => {
        setAssist(nextAssistSeq())
        compose({ deviceId: 'local' })
      }),
    [compose],
  )

  // 别处要打开某个会话（浏览器的 show 留在别的会话上的提示，点“去看”）
  useEffect(() => onOpenSessionRequest(select), [select])

  // 别处要直接进某台设备的详情（顶栏弹层里“不确认”那一行的“去设置”、侧栏设备行上的升级记号）
  useEffect(
    () =>
      onDeviceRequest((deviceId, section) =>
        leaveThen(() => {
          setDeviceAt((was) => ({ deviceId, section, seq: (was?.seq ?? 0) + 1 }))
          openPage('devices')
        }),
      ),
    [openPage],
  )

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
        onPage={onPage}
      />
      <div className="body">
        <main className="main">
          <Toasts />
          <TaskNotices onOpen={select} />
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
            <DevicesPage
              key={deviceAt?.seq ?? 0}
              initial={deviceAt?.deviceId ?? null}
              section={deviceAt?.section ?? null}
              onClose={closePage}
            />
          ) : page === 'tasks' ? (
            <TasksPage
              key={tasksAt.seq}
              initial={tasksAt.route}
              onClose={closePage}
              onOpenSession={select}
            />
          ) : page === 'settings' ? (
            <SettingsPage
              section={settingsAt}
              onSection={setSettingsAt}
              onClose={closePage}
              onDevices={openDevices}
              onArchived={() => openPage('archived')}
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
              assist={assist}
            />
          )}
          {/* 首启引导盖在主区域上，侧栏照常能用 */}
          <Onboarding />
          {/* 终端面板一直在，收起只是不显示：里面的终端不跟着上面的内容换来换去 */}
          <TerminalSlot selection={selection} draft={draft} page={page} />
        </main>
        {/* 右边常驻的信息栏（待办等）：有内容才出来，排在对话和侧面板之间 */}
        {selection && !page ? (
          <InfoRail
            key={`${selection.deviceId}:${selection.sessionId}`}
            deviceId={selection.deviceId}
            sessionId={selection.sessionId}
          />
        ) : null}
        {/* 右边的侧面板（文件）：跟着眼前的会话走，收起只是不显示 */}
        <SideSlot selection={selection} draft={draft} page={page} />
      </div>
      {/* litch config 要界面做的事、放宽安全的确认卡、执行器开的出码对话框 */}
      <ConfigAgent />
      {/* 有没保存的改动时离开前问的那个对话框 */}
      <LeaveGuardHost />
    </div>
  )
}
