// 离得远的组件请应用外框办的事：开一个新对话（输入框里的 `/new`，和 Cmd/Ctrl+N 是同一个动作）、
// 打开设置页的某一组（设备详情里“去设置里看看”）、打开某个会话（提示上的“去看”）、打开配置助手。
// 外框（App.tsx）听着，别处只管提出来。
const listeners = new Set<() => void>()

/** 到新建对话页去，建在眼前这个会话所在的工作区里 */
export function requestNewSession(): void {
  for (const listener of listeners) listener()
}

/** 外框登记自己。返回取消登记的函数 */
export function onNewSessionRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const settingsListeners = new Set<(section: string) => void>()

/** 打开设置页，到这一组（SettingsPage.tsx 的 SETTINGS_SECTIONS 里的一个） */
export function requestSettings(section: string): void {
  for (const listener of settingsListeners) listener(section)
}

export function onSettingsRequest(listener: (section: string) => void): () => void {
  settingsListeners.add(listener)
  return () => {
    settingsListeners.delete(listener)
  }
}

export interface SessionRef {
  deviceId: string
  sessionId: string
}

const openListeners = new Set<(session: SessionRef) => void>()

/** 打开这个会话（和在侧栏里点它一样） */
export function requestOpenSession(session: SessionRef): void {
  for (const listener of openListeners) listener(session)
}

export function onOpenSessionRequest(listener: (session: SessionRef) => void): () => void {
  openListeners.add(listener)
  return () => {
    openListeners.delete(listener)
  }
}

/** 设备详情里要直接去的一节。service：“设备服务”那一节（侧栏设备行上的升级记号） */
export type DeviceSection = 'service'

const deviceListeners = new Set<(deviceId: string, section: DeviceSection | null) => void>()

/** 打开“设备”一页，直接进这台设备的详情（顶栏弹层里“不确认”那一行的“去设置”）；给了 section 就停在那一节 */
export function requestDevice(deviceId: string, section: DeviceSection | null = null): void {
  for (const listener of deviceListeners) listener(deviceId, section)
}

export function onDeviceRequest(
  listener: (deviceId: string, section: DeviceSection | null) => void,
): () => void {
  deviceListeners.add(listener)
  return () => {
    deviceListeners.delete(listener)
  }
}

/** 定时任务那一页里要去的地方：列表、某个任务的详情、新建（可以指定在哪个会话里接着发） */
export type TasksRoute =
  | { view: 'list' }
  | { view: 'detail'; deviceId: string; taskId: string }
  | { view: 'new'; deviceId: string | null; threadId: string | null }

const taskListeners = new Set<(route: TasksRoute) => void>()

/** 打开“定时任务”一页，到这个地方（会话顶上那一条的“去看任务”、会话菜单的“为这个会话建定时任务”） */
export function requestTasks(route: TasksRoute): void {
  for (const listener of taskListeners) listener(route)
}

export function onTasksRequest(listener: (route: TasksRoute) => void): () => void {
  taskListeners.add(listener)
  return () => {
    taskListeners.delete(listener)
  }
}

const assistantListeners = new Set<() => void>()

export type ManagersRoute =
  | { view: 'list' }
  | { view: 'new'; deviceId?: string; workspaceId?: string | null }
const managerListeners = new Set<(route: ManagersRoute) => void>()
export function requestManagers(route: ManagersRoute): void {
  for (const listener of managerListeners) listener(route)
}
export function onManagersRequest(listener: (route: ManagersRoute) => void): () => void {
  managerListeners.add(listener)
  return () => {
    managerListeners.delete(listener)
  }
}

/**
 * 打开配置助手：到新建对话页、设备切到本机（手册只装在本机），harness 和模型照上次的不动，
 * 输入框里放好“使用 Litch 产品手册帮我配置：”（有技能就带技能片），原来写的接在后面
 */
export function requestAssistant(): void {
  for (const listener of assistantListeners) listener()
}

export function onAssistantRequest(listener: () => void): () => void {
  assistantListeners.add(listener)
  return () => {
    assistantListeners.delete(listener)
  }
}
