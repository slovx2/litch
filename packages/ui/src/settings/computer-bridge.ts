// 桌面外壳的预加载脚本挂在 window.litchComputerUse 上的 Computer Use 设置接口（apps/desktop/src/preload.mts，
// 主进程那一侧在 apps/desktop/src/computer-use/settings.mts），这里是界面这边的类型，改一边要改另一边。
// 只有 macOS 上的桌面外壳有它：Linux、Windows 和普通浏览器里没有，设置页就不显示 Computer Use 那一节。

/** 两项系统权限：辅助功能、屏幕录制 */
export type PermissionPane = 'accessibility' | 'screenRecording'

export interface ComputerPermissions {
  accessibility: boolean
  screenRecording: boolean
}

export interface ComputerUseState {
  /** ready：助手在跑、刚问过；idle：没在跑，没去拉起（只看了上一次的）；failed：拉起或问的时候出错了 */
  helper: 'ready' | 'idle' | 'failed'
  /** idle 时是这次运行里上一次问到的，没问过是 null；failed 时是 null */
  permissions: ComputerPermissions | null
  /** failed 时的原因（原话） */
  reason?: string
}

/** “始终允许”的一个应用 */
export interface AlwaysAllowedApp {
  bundleId: string
  name: string
  /** 什么时候加的（ISO 时间） */
  addedAt: string
}

export interface ComputerUseBridge {
  /** launch：助手没在跑时要不要拉起它。设置页那一节要；设备详情里顺带看一眼不要（不为看一眼拉起助手） */
  status(launch: boolean): Promise<ComputerUseState | null>
  /** 打开系统设置里对应的那一页，让用户自己去打开开关（应用不替用户改） */
  openSettings(pane: PermissionPane): Promise<boolean>
  /** 重启助手：屏幕录制授权之后要重启进程才生效。回重启之后的状态 */
  restart(): Promise<ComputerUseState | null>
  apps(): Promise<AlwaysAllowedApp[]>
  /** 从“始终允许”里删掉一个，回删没删掉 */
  forgetApp(bundleId: string): Promise<boolean>
}

declare global {
  interface Window {
    litchComputerUse?: ComputerUseBridge
  }
}

/** 外壳给的接口。不是 macOS 上的桌面外壳、或者不在页面里（单元测试直接在 Node 里读源文件）时没有 */
export const computerBridge = (): ComputerUseBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.litchComputerUse
