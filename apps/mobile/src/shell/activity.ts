// 手机上的「最近」记录：规则全在核心的 SidebarActivity（packages/core/src/projection/sidebar-activity.mts），
// 和桌面同一套 5 秒门槛、清零和主动操作即时记。这里只把手机的两样输入接给它：
//   - 前台：应用处在 active。iOS 锁屏、拉下通知中心、切应用时先 inactive 再 background，安卓锁屏是 background，都不算；
//   - 正在看哪个会话：导航当前页是会话详情页才算，换到别的页（列表、终端、子代理页……）就是离开。
// 不引用 react-native，平台的东西由调用方传进来，单测（test/recent.test.mjs）直接喂假的前后台和导航。
import {
  type Clock,
  type CoreChannel,
  createSidebarActivity,
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

/** 当前页是会话详情才算在看那个会话 */
export function viewedSession(
  route: RouteLike | undefined,
): { deviceId: string; sessionId: string } | null {
  if (route?.name !== 'Detail') return null
  const params = route.params as { deviceId?: unknown; sessionId?: unknown } | undefined
  return typeof params?.deviceId === 'string' && typeof params.sessionId === 'string'
    ? { deviceId: params.deviceId, sessionId: params.sessionId }
    : null
}

/** 把前后台和当前页接给核心；退到后台时顺手把攒着的记录写下去（进程随时可能被系统杀掉） */
export function watchMobileActivity(
  activity: SidebarActivity,
  app: AppStateSource,
  navigation: NavigationSource,
): () => void {
  const showing = () => activity.view(viewedSession(navigation.current()))
  activity.setForeground(app.current() === 'active')
  showing()
  const stopApp = app.listen((state) => {
    activity.setForeground(state === 'active')
    if (state === 'background') activity.flush()
  })
  const stopNavigation = navigation.listen(showing)
  return () => {
    stopApp()
    stopNavigation()
    activity.setForeground(false)
    activity.view(null)
    activity.flush()
  }
}
