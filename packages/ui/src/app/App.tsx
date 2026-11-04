import { setBoardLayout } from '../manager/board-layout.ts'
import { TitleSearch } from '../search/TitleSearch.tsx'
import { SuggestionsPage } from '../tree/SuggestionsPage.tsx'
import { useT } from './appearance.ts'
import '../styles/suggestions.css'
import { ManagerTitleBar } from '../manager/ManagerTitleBar.tsx'
import '../styles/manager.css'
import { keys, managerMark, openSessionWhenKnown, type SessionSummary } from '@litch/core'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArchivedPage } from '../archived/ArchivedPage.tsx'
import { ArchivedSession } from '../archived/ArchivedSession.tsx'
import { ConfigAgent } from '../assist/ConfigAgent.tsx'
import { nextAssistSeq } from '../assist/useAssistant.ts'
import { NewSession } from '../composer/NewSession.tsx'
import type { PlaceWish } from '../composer/new-place.ts'
import { useNewPlace } from '../composer/useNewPlace.ts'
import { ApprovalNotices } from '../devices/ApprovalNotices.tsx'
import { DevicesPage } from '../devices/DevicesPage.tsx'
import { useManagers } from '../manager/data.ts'
import { ManagerOrigin, ManagerPage, type ManagerPageLocation } from '../manager/ManagerPage.tsx'
import { ManagersPage } from '../manager/ManagersPage.tsx'
import { SessionNotices } from '../notify/SessionNotices.tsx'
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
  type ManagersRoute,
  onAssistantRequest,
  onDeviceRequest,
  onManagersRequest,
  onNewSessionRequest,
  onOpenSessionRequest,
  onSettingsRequest,
  onSuggestionsRequest,
  onTasksRequest,
  requestOpenSession,
  type TasksRoute,
} from './actions.ts'
import { LeaveGuardHost, leaveThen } from './leave-guard.tsx'
import { NavigationBar } from './NavigationBar.tsx'
import { type AuxiliaryPage, PageWindow } from './PageWindow.tsx'
import { readWhileOpen } from './read.ts'
import { useKey, useServices } from './services.tsx'
import { TitleBar } from './TitleBar.tsx'
import { Toasts } from './toasts.tsx'
import { useNavigation } from './useNavigation.ts'
import { useSelectionLifetime } from './useSelectionLifetime.ts'
import type { NavigationAction, ViewNavigation } from './view-navigation.ts'

/** 主页面与侧栏打开的模态入口。设置（含设备）、建议、定时任务不进入主导航历史。 */
export type Page = 'archived' | 'devices' | 'settings' | 'tasks' | 'managers' | 'suggestions'

export interface Selection {
  deviceId: string
  sessionId: string
  /** 来自经理对象或创建应答的已确认身份，目录可稍后到达。 */
  managerId?: string
}

/** 正在写第一条消息、还没建出来的会话。workspaceId 为 null 表示不属于任何工作区 */
export interface Draft {
  deviceId: string
  workspaceId: string | null
}

export function App() {
  const { channel, replica } = useServices()
  useUpdateToast()
  const t = useT()
  const managerData = useManagers()
  const bindings = useRef(new Map<string, string>())
  const validLocation = useCallback(
    (state: ViewNavigation) => {
      const location = state.location
      return (
        !!location.page ||
        !location.picked ||
        !!replica.store.get(keys.summary(location.picked.deviceId, location.picked.sessionId))
      )
    },
    [replica],
  )
  const { navigation, dispatch: visit, go: travel, back, forward } = useNavigation(validLocation)
  const opening = useRef<(() => void) | null>(null)
  const cancelOpening = useCallback(() => {
    opening.current?.()
    opening.current = null
  }, [])
  useEffect(() => cancelOpening, [cancelOpening])
  const dispatch = useCallback(
    (action: NavigationAction) => {
      // 切树和清理失效会话都不是改选，不能取消正在等待身份确认的打开请求。
      if (action.type !== 'missing' && action.type !== 'switch') cancelOpening()
      visit(action)
    },
    [cancelOpening, visit],
  )
  const go = useCallback(
    (direction: -1 | 1) => {
      cancelOpening()
      travel(direction)
    },
    [cancelOpening, travel],
  )
  const [auxiliary, setAuxiliary] = useState<AuxiliaryPage | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 浮窗开关本身就是离开动作，须取消尚未确认身份的导航。
  useLayoutEffect(() => cancelOpening(), [auxiliary, cancelOpening])
  const closeAuxiliary = useCallback(() => leaveThen(() => setAuxiliary(null)), [])
  const sidebarMode = navigation.mode
  const { picked, wish, page, peek = null } = navigation.location
  const setPeek = useCallback(
    (selection: Selection | null) => dispatch({ type: 'peek', selection }),
    [dispatch],
  )
  const setWish = (wish: PlaceWish | null) => dispatch({ type: 'wish', wish })
  const [managerLocations, setManagerLocations] = useState<Record<string, ManagerPageLocation>>({})
  const managersAt = navigation.location.managersRoute ?? { view: 'list' as const }
  /**
   * 新建对话页上明说的去处：从侧栏工作区行的加号带过来的，或者在页上自己换的。
   * null：按默认的来（上次用的设备和工作区）
   */
  const place = useNewPlace(wish)
  /** 设置页上正看着哪一组。记在这里：应用菜单的“关于”要能直接开到那一组 */
  const [settingsAt, setSettingsAt] = useState<SettingsSection>('look')
  // 选中的会话被归档或删掉了：回到新建对话页。
  // “没有摘要”不等于“没了”：刚建的会话，摘要可能比建好的应答晚一帧到，所以要见过之后又没了才算
  const pickedSummary = useKey<SessionSummary>(
    keys.summary(picked?.deviceId ?? '', picked?.sessionId ?? ''),
  )
  const mark = pickedSummary ? managerMark(pickedSummary) : null
  const historicalManager = managerData.managers.find(
    (manager) =>
      manager.deviceId === picked?.deviceId && manager.historyThreadIds?.includes(picked.sessionId),
  )
  const pickedManager = managerData.managers.find(
    (manager) => manager.deviceId === picked?.deviceId && manager.threadId === picked.sessionId,
  )
  const waitingManager =
    (mark?.role === 'manager' || !!picked?.managerId) && !historicalManager && !pickedManager
  const owner =
    mark?.role === 'line'
      ? managerData.managers.find(
          (manager) => manager.deviceId === picked?.deviceId && manager.id === mark.managerId,
        )
      : undefined
  useEffect(() => {
    for (const manager of managerData.managers) {
      const key = `${manager.deviceId}:${manager.id}`
      const previous = bindings.current.get(key)
      bindings.current.set(key, manager.threadId)
      if (
        previous &&
        previous !== manager.threadId &&
        picked?.deviceId === manager.deviceId &&
        picked.sessionId === previous
      )
        requestOpenSession({ deviceId: manager.deviceId, sessionId: manager.threadId })
    }
  }, [managerData.managers, picked])
  const forgetSelection = useCallback(
    (selection: Selection) => dispatch({ type: 'missing', selection }),
    [dispatch],
  )
  useSelectionLifetime(picked, managerData.managers, forgetSelection)
  /** 正在写的新会话要建在哪。选中了会话就没有它；一台设备都没有的时候也是 null */
  const draft: Draft | null = picked ? null : place
  // 开着某一页的时候，侧栏里没有哪个会话是选中的
  const selection = page ? null : picked

  // 只记实际呈现在主区域的会话；预取、打开侧面板和后台订阅不算查看。
  const viewingDevice = auxiliary || waitingManager ? undefined : selection?.deviceId
  const viewingSession = auxiliary || waitingManager ? undefined : selection?.sessionId
  // 随画面提交即取消旧计时，不能等下一轮被动 effect 才处理切走。
  useLayoutEffect(() => {
    replica.viewSession(
      viewingDevice && viewingSession
        ? { deviceId: viewingDevice, sessionId: viewingSession }
        : null,
    )
    return () => replica.viewSession(null)
  }, [viewingDevice, viewingSession, replica])

  // 开着一个会话就算读过了：摘要上的未读一出现就清（摘要比选中晚到的也算）
  useEffect(() => {
    if (!selection || auxiliary || waitingManager) return
    return readWhileOpen(channel, replica.store, selection.deviceId, selection.sessionId)
  }, [selection, auxiliary, waitingManager, channel, replica])

  // 换页的动作都先过 leaveThen：眼前那一页有没保存的改动（harness 详情设置）时先问，问完了才换（leave-guard.tsx）
  const openPage = useCallback(
    (next: Page | null, preview: Selection | null = null) => {
      if (next === 'settings' && auxiliary === 'settings') return
      leaveThen(() => {
        cancelOpening()
        if (next === 'devices') {
          setSettingsAt('devices')
          setAuxiliary('settings')
          return
        }
        if (next === 'settings' || next === 'suggestions' || next === 'tasks') {
          setAuxiliary(next)
          return
        }
        setAuxiliary(null)
        dispatch({ type: 'page', page: next, peek: preview })
      })
    },
    [dispatch, auxiliary, cancelOpening],
  )
  const select = useCallback(
    (next: Selection) =>
      leaveThen(() => {
        cancelOpening()
        opening.current = openSessionWhenKnown(
          replica.store,
          next.deviceId,
          next.sessionId,
          () => {
            setAuxiliary(null)
            dispatch({ type: 'select', selection: next })
          },
          next.managerId,
        )
      }),
    [replica, cancelOpening, dispatch],
  )
  /** 到新建对话页去。next 是明说要建在哪；null 是按默认的来 */
  const compose = useCallback(
    (next: PlaceWish | null) =>
      leaveThen(() => {
        setAuxiliary(null)
        dispatch({ type: 'compose', wish: next })
        setPeek(null)
      }),
    [setPeek, dispatch],
  )
  useEffect(
    () =>
      onManagersRequest((route) =>
        leaveThen(() => {
          const deviceId =
            route.view === 'new'
              ? (route.deviceId ?? picked?.deviceId ?? place?.deviceId)
              : undefined
          const target: ManagersRoute =
            route.view === 'new'
              ? {
                  ...route,
                  ...(deviceId ? { deviceId } : {}),
                  workspaceId:
                    route.workspaceId ?? pickedSummary?.workspaceId ?? place?.workspaceId ?? null,
                }
              : route
          setAuxiliary(null)
          dispatch({ type: 'managers', route: target })
          setPeek(null)
        }),
      ),
    [
      picked?.deviceId,
      pickedSummary?.workspaceId,
      place?.deviceId,
      place?.workspaceId,
      dispatch,
      setPeek,
    ],
  )
  const switchSidebar = (mode: 'chat' | 'manager') => dispatch({ type: 'switch', mode })
  const closePage = useCallback(() => openPage(null), [openPage])
  /** 别处要求直接进哪台设备的详情。seq 每次都变，同一台再要一次也重新进 */
  const [deviceAt, setDeviceAt] = useState<{
    deviceId: string | null
    section: DeviceSection | null
    seq: number
  } | null>(null)
  const openDevices = useCallback(
    () =>
      leaveThen(() => {
        setDeviceAt((was) => ({ deviceId: null, section: null, seq: (was?.seq ?? 0) + 1 }))
        openPage('devices')
      }),
    [openPage],
  )
  const closePeek = useCallback(() => setPeek(null), [setPeek])
  /** 定时任务那一页一打开去哪。seq 每次都变：在那一页里再要一次也重新进 */
  const [tasksAt, setTasksAt] = useState<{ route: TasksRoute; seq: number }>({
    route: { view: 'list' },
    seq: 0,
  })
  const onPage = useCallback(
    (next: Page) => {
      if (next === 'tasks') setTasksAt((was) => ({ route: { view: 'list' }, seq: was.seq + 1 }))
      openPage(next)
    },
    [openPage],
  )
  useEffect(() => onSuggestionsRequest(() => onPage('suggestions')), [onPage])
  // 别处要去定时任务的某个地方（会话顶上那一条的“去看任务”、会话菜单的“为这个会话建定时任务”）
  useEffect(
    () =>
      onTasksRequest((route: TasksRoute) => {
        setTasksAt((was) => ({ route, seq: was.seq + 1 }))
        openPage('tasks')
      }),
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
      if (action === 'settings.about')
        leaveThen(() => {
          setSettingsAt('about')
          setAuxiliary('settings')
        })
      else openPage('settings')
    })
    // 别处要直接开到某一组（设备详情里 Computer Use 开关旁的“去设置里看看”）。
    // “设备”原来是设置里的一组，现在是设置页上直接进设备页的入口：要它就直接进设备页
    const offAsk = onSettingsRequest((section: string) => {
      if (section === 'devices') return openDevices()
      leaveThen(() => {
        if (isSettingsSection(section)) setSettingsAt(section)
        setAuxiliary('settings')
      })
    })
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
      onAssistantRequest(() =>
        leaveThen(() => {
          setAssist(nextAssistSeq())
          compose({ deviceId: 'local' })
        }),
      ),
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
      if (document.querySelector('dialog[open]')) return
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
    <div
      className={
        (pickedManager || waitingManager) && !page ? 'app main-app mg-app' : 'app main-app'
      }
    >
      <NavigationBar back={back} forward={forward} go={go} />
      <TitleSearch
        onOpen={(next, archived) => {
          if (archived)
            leaveThen(() => {
              openPage('archived', next)
            })
          else select(next)
        }}
      />
      {page === 'managers' || (!page && (pickedManager || waitingManager || owner)) ? (
        <ManagerTitleBar
          {...(page
            ? {}
            : pickedManager
              ? { manager: pickedManager }
              : owner
                ? { manager: owner, ...(pickedSummary ? { child: pickedSummary } : {}) }
                : {})}
        />
      ) : (
        <TitleBar
          selection={selection}
          draft={peek ? null : draft}
          page={page}
          peek={peek}
          devicePageId={null}
          onCompose={compose}
        />
      )}
      {/* 侧栏和右边那一块（对话加侧面板）并排，各占一栏：侧栏变宽变窄、收起，右边那一块的宽度跟着变 */}
      <Sidebar
        mode={sidebarMode}
        onMode={switchSidebar}
        managers={managerData.managers}
        devices={managerData.devices}
        selection={selection}
        draft={page ? null : draft}
        page={auxiliary ?? page}
        onSelect={select}
        onCompose={compose}
        onPage={onPage}
      />
      <div className="body">
        <main className="main">
          <Toasts />
          <ApprovalNotices />
          <TaskNotices onOpen={select} />
          <SessionNotices onOpen={select} selection={auxiliary ? null : selection} />
          {(page === 'archived' || page === 'suggestions' || (!page && pickedManager)) && peek ? (
            <ArchivedSession
              key={`${peek.deviceId}:${peek.sessionId}`}
              {...peek}
              onBack={closePeek}
              onRestored={select}
            />
          ) : page === 'archived' ? (
            <ArchivedPage onClose={closePage} onOpen={setPeek} />
          ) : page === 'managers' ? (
            <ManagersPage
              key={JSON.stringify(managersAt)}
              initial={managersAt}
              onRoute={(route) => dispatch({ type: 'managers', route })}
              {...managerData}
              onClose={closePage}
              onOpen={select}
            />
          ) : selection && pickedManager ? (
            <ManagerPage
              key={`${pickedManager.deviceId}:${pickedManager.id}`}
              manager={pickedManager}
              onSuggestionSource={(next, archived) => {
                if (archived) setPeek(next)
                else select(next)
              }}
              location={managerLocations[`${pickedManager.deviceId}:${pickedManager.id}`]}
              onLocation={(location) =>
                setManagerLocations((was) => ({
                  ...was,
                  [`${pickedManager.deviceId}:${pickedManager.id}`]: location,
                }))
              }
              onOpen={select}
            />
          ) : selection && waitingManager ? (
            <div className="empty">{t('manager.loading')}</div>
          ) : selection ? (
            <>
              {owner ? (
                <ManagerOrigin manager={owner} threadId={selection.sessionId} onOpen={select} />
              ) : null}
              <Transcript
                onOpen={select}
                key={`${selection.deviceId}:${selection.sessionId}`}
                deviceId={selection.deviceId}
                sessionId={selection.sessionId}
                {...(historicalManager
                  ? { footer: <div className="empty">{t('manager.resetHistoryReadOnly')}</div> }
                  : {})}
              />
            </>
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
        {selection && !page && !pickedManager && !waitingManager ? (
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
      {auxiliary ? (
        <PageWindow kind={auxiliary} onClose={closeAuxiliary}>
          {auxiliary === 'suggestions' ? (
            <SuggestionsPage
              onManager={(manager) => {
                setBoardLayout({ open: true })
                setManagerLocations((was) => ({
                  ...was,
                  [`${manager.deviceId}:${manager.id}`]: {
                    ...was[`${manager.deviceId}:${manager.id}`],
                    tab: 'suggestions',
                    narrow: 'board',
                    settings: false,
                  },
                }))
                select({ deviceId: manager.deviceId, sessionId: manager.threadId })
              }}
              onClose={closeAuxiliary}
              onOpen={(next, archived) => {
                if (archived) {
                  openPage('archived', next)
                } else select(next)
              }}
            />
          ) : auxiliary === 'tasks' ? (
            <TasksPage
              key={tasksAt.seq}
              initial={tasksAt.route}
              onClose={closeAuxiliary}
              onOpenSession={select}
            />
          ) : (
            <SettingsPage
              section={settingsAt}
              onSection={(section) => leaveThen(() => setSettingsAt(section))}
              onClose={closeAuxiliary}
              onDevices={openDevices}
              onArchived={() => openPage('archived')}
              devices={
                <DevicesPage
                  key={deviceAt?.seq ?? 0}
                  initial={deviceAt?.deviceId ?? null}
                  section={deviceAt?.section ?? null}
                  onClose={closeAuxiliary}
                />
              }
            />
          )}
        </PageWindow>
      ) : null}
      {/* 有没保存的改动时离开前问的那个对话框 */}
      <LeaveGuardHost />
    </div>
  )
}
