// 手机上的「最近」记录：规则全在核心的 SidebarActivity（packages/core/src/projection/sidebar-activity.mts），
// 和桌面同一套 5 秒门槛、清零和主动操作即时记。这里只把手机的两样输入接给它：
//   - 前台：应用处在 active。iOS 锁屏、拉下通知中心、切应用时先 inactive 再 background，安卓锁屏是 background，都不算；
//   - 正在看哪个会话：会话详情或经理页；经理 ID 通过常驻目录解析为会话，列表、终端等不算查看。
// 不引用 react-native，平台的东西由调用方传进来，单测（test/recent.test.mjs）直接喂假的前后台和导航。
import {
  type Clock,
  type CoreChannel,
  createSidebarActivity,
  type SessionDestination,
  type SidebarActivity,
} from '@litch/core'
import type { JsonFile } from './json-file'

export interface AppStateSource {
  current(): string
  listen(changed: (state: string) => void): () => void
}

export interface RouteLike {
  name: string
  params?: object | undefined
}

export interface NavigationSource {
  current(): RouteLike | undefined
  listen(changed: () => void): () => void
}

export interface ManagerSessions {
  get(deviceId: string, managerId: string): string | undefined
  subscribe(deviceId: string, managerId: string, changed: () => void): () => void
  destination(deviceId: string, sessionId: string): SessionDestination
  subscribeDestination(deviceId: string, sessionId: string, changed: () => void): () => void
}

/** 记录存在本机（各客户端各记各的，不经设备同步） */
export function createMobileActivity(
  channel: CoreChannel,
  clock: Clock,
  file: JsonFile<unknown>,
): SidebarActivity {
  return createSidebarActivity(channel, clock, {
    load: () => file.read(),
    save: (entries) => file.write(entries),
  })
}

/** 会话详情直接给会话标识，经理页从已订阅的目录取经理会话。 */
export function viewedSession(
  route: RouteLike | undefined,
  managers?: Pick<ManagerSessions, 'get' | 'destination'>,
): { deviceId: string; sessionId: string } | null {
  if (route?.name === 'ManagerConsole') {
    const params = route.params as { deviceId?: unknown; managerId?: unknown } | undefined
    if (typeof params?.deviceId !== 'string' || typeof params.managerId !== 'string') return null
    const sessionId = managers?.get(params.deviceId, params.managerId)
    return sessionId ? { deviceId: params.deviceId, sessionId } : null
  }
  if (route?.name !== 'Detail') return null
  const params = route.params as { deviceId?: unknown; sessionId?: unknown } | undefined
  if (typeof params?.deviceId !== 'string' || typeof params.sessionId !== 'string') return null
  // 身份闸门仍在等待或即将换成经理工作台时，还没有呈现会话。
  if (managers && managers.destination(params.deviceId, params.sessionId) !== null) return null
  return { deviceId: params.deviceId, sessionId: params.sessionId }
}

/** 把前后台和当前页接给核心；退到后台时顺手把攒着的记录写下去（进程随时可能被系统杀掉） */
export function watchMobileActivity(
  activity: SidebarActivity,
  app: AppStateSource,
  navigation: NavigationSource,
  managers?: ManagerSessions,
): () => void {
  let stopManager: (() => void) | undefined
  const showing = () => activity.view(viewedSession(navigation.current(), managers))
  const changed = () => {
    stopManager?.()
    stopManager = undefined
    const route = navigation.current()
    const params = route?.params as
      | { deviceId?: unknown; managerId?: unknown; sessionId?: unknown }
      | undefined
    if (
      route?.name === 'ManagerConsole' &&
      typeof params?.deviceId === 'string' &&
      typeof params.managerId === 'string'
    )
      stopManager = managers?.subscribe(params.deviceId, params.managerId, showing)
    else if (
      route?.name === 'Detail' &&
      typeof params?.deviceId === 'string' &&
      typeof params.sessionId === 'string'
    )
      stopManager = managers?.subscribeDestination(params.deviceId, params.sessionId, showing)
    showing()
  }
  activity.setForeground(app.current() === 'active')
  changed()
  const stopApp = app.listen((state) => {
    activity.setForeground(state === 'active')
    if (state === 'background') activity.flush()
  })
  const stopNavigation = navigation.listen(changed)
  return () => {
    stopApp()
    stopNavigation()
    stopManager?.()
    activity.setForeground(false)
    activity.view(null)
    activity.flush()
  }
}
