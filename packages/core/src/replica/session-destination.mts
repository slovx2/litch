import type { DeviceView, SessionSummary } from '../model.mjs'
import type { ManagerView } from '../model-manager.mjs'
import { managerMark } from '../projection/manager.mjs'
import type { KeyedStore } from './keyed-store.mjs'
import { keys } from './replica.mjs'

/** 字符串是经理 ID，null 是普通会话，undefined 表示身份尚未确认。 */
export type SessionDestination = string | null | undefined

/** 两端打开会话共用的身份判断；工作线仍是普通会话，重置前的历史不会误开现任经理。 */
export function sessionDestination(
  store: KeyedStore,
  deviceId: string,
  sessionId: string,
): SessionDestination {
  const ids = store.get<string[]>(keys.managerIds(deviceId)) ?? []
  for (const id of ids) {
    const manager = store.get<ManagerView>(keys.manager(deviceId, id))
    if (manager?.threadId === sessionId) return id
    if (manager?.historyThreadIds?.includes(sessionId)) return null
  }
  const summary = store.get<SessionSummary>(keys.summary(deviceId, sessionId))
  const mark = summary && managerMark(summary)
  if (mark?.role === 'manager') return mark.managerId
  if (mark?.role === 'line') return null
  // 目录先到或摘要先到都不能把尚未标记的经理当成普通对话。
  const available = store.get<boolean | null>(keys.managersAvailable(deviceId))
  // 离线缓存已经保存会话标记；不能让普通缓存对话等待一个尚未连接的经理目录。
  const cached = store.get<DeviceView>(keys.device(deviceId))?.stale === true
  if (summary && (typeof available === 'boolean' || cached)) return null
  return undefined
}

/** 只订阅身份依赖；经理重置会改绑定但不改 ID 列表，因此也监听目录中的每位经理。 */
export function subscribeSessionDestination(
  store: KeyedStore,
  deviceId: string,
  sessionId: string,
  changed: () => void,
): () => void {
  let managerStops: (() => void)[] = []
  const bindManagers = () => {
    for (const stop of managerStops) stop()
    managerStops = (store.get<string[]>(keys.managerIds(deviceId)) ?? []).map((id) =>
      store.subscribe(keys.manager(deviceId, id), changed),
    )
  }
  const stops = [
    store.subscribe(keys.device(deviceId), changed),
    store.subscribe(keys.summary(deviceId, sessionId), changed),
    store.subscribe(keys.managersAvailable(deviceId), changed),
    store.subscribe(keys.managerIds(deviceId), () => {
      bindManagers()
      changed()
    }),
  ]
  bindManagers()
  return () => {
    for (const stop of [...stops, ...managerStops]) stop()
  }
}

/** 确认身份后只打开一次；返回的取消函数用于离开、改选和卸载。 */
export function openSessionWhenKnown(
  store: KeyedStore,
  deviceId: string,
  sessionId: string,
  open: (destination: Exclude<SessionDestination, undefined>) => void,
  knownManagerId?: string,
): () => void {
  // 创建应答已经给出经理身份，不必等待稍后到达的目录增量。
  if (knownManagerId) {
    open(knownManagerId)
    return () => {}
  }
  let done = false
  let unsubscribe = () => {}
  const cancel = () => {
    done = true
    unsubscribe()
  }
  const check = () => {
    if (done) return
    const destination = sessionDestination(store, deviceId, sessionId)
    if (destination === undefined) return
    cancel()
    open(destination)
  }
  unsubscribe = subscribeSessionDestination(store, deviceId, sessionId, check)
  check()
  return cancel
}
