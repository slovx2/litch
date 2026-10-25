// 设置页里 Computer Use 那一节在主进程这一侧要的几件事：助手和两项系统权限的状态、打开系统设置对应的那一页、
// 重启助手。界面经预加载脚本的 window.litchComputerUse 调，消息在 main.mts 里登记
// （只认界面自己的主框架发来的）。这里不引 electron，方便测试。
//
// 查权限要助手在跑。launch 为真（用户打开了设置页的那一节）时，助手没在跑就拉起它；为假（设备详情里顺带看一眼）时
// 不拉起：只问在跑的那个，没在跑就回这次运行里上一次问到的（一次都没问过是 null）。权限只用助手那头不弹窗的检查
// （AXIsProcessTrusted、CGPreflightScreenCaptureAccess），这里不碰系统设置，也不替用户授权。
// 只有用户点“打开系统设置”时助手才向系统申请一次，好让列表里出现“Litch Computer Use”（Apps.swift 开头）。
//
// Windows 上没有系统权限这回事：这一节换成助手的状态（在不在跑、版本、上次的错）和两条提醒的依据——
// 助手的完整性级别（助手继承 Litch 的令牌，高于 medium 就是 Litch 以管理员身份运行）、UAC 开没开。
//
// LITCH_COMPUTER_USE_PERMISSIONS 是给自检和截图用的：设了就不碰助手，权限照它说的回
// （none、accessibility、screenRecording、both），打开系统设置、重启助手都只当作做了。
// Windows 上设了它（任何认得的值）也不碰助手，助手的状态照一份假的回。
import type { WinHelperInfo } from './index.mjs'
import type { PermissionStatus } from './wire.mjs'

export type PermissionPane = 'accessibility' | 'screenRecording'

export interface ComputerUseState {
  /** 这台桌面的平台：darwin 有两项系统权限，win32 没有、看助手的状态 */
  platform: 'darwin' | 'win32'
  /** ready：助手在跑、刚问过；idle：没在跑，没去拉起；failed：拉起或问的时候出错了 */
  helper: 'ready' | 'idle' | 'failed'
  /** 两项权限（macOS）。idle 时是上一次问到的，没问过是 null；failed 时、Windows 上是 null */
  permissions: PermissionStatus | null
  /** 助手握手时报的（Windows）。idle 时是这次运行里上一次的，没起过是 null */
  windows?: WinHelperInfo | null
  /** failed 时的原因（原话）；Windows 上 idle 时是上一次拉起或连接出的错 */
  reason?: string
}

/** 要用到的 Computer Use 的几样（computer-use/index.mts 返回的对象上都有，running 由调用方从 supervisor 算） */
export interface ComputerUseControls {
  platform: 'darwin' | 'win32'
  /** 查两项权限（macOS，会拉起助手） */
  permissions(): Promise<PermissionStatus>
  /** 助手握手时报的（Windows）。launch 为真时没在跑就拉起它 */
  helperInfo(launch: boolean): Promise<WinHelperInfo | null>
  /** 上一次拉起或连接出的错 */
  lastError(): string | null
  /** 助手现在在不在跑（不拉起） */
  running(): boolean
  openPermissionSettings(pane: PermissionPane): Promise<boolean>
  restartHelper(): Promise<void>
}

export interface ComputerUseSettings {
  status(launch: boolean): Promise<ComputerUseState>
  openSettings(pane: unknown): Promise<boolean>
  restart(): Promise<ComputerUseState>
}

export const isPane = (value: unknown): value is PermissionPane =>
  value === 'accessibility' || value === 'screenRecording'

/** 自检用的假权限。认不出的值当作没设 */
export function fakePermissions(value: string | undefined): PermissionStatus | null {
  switch (value) {
    case 'none':
      return { accessibility: false, screenRecording: false }
    case 'accessibility':
      return { accessibility: true, screenRecording: false }
    case 'screenRecording':
      return { accessibility: false, screenRecording: true }
    case 'both':
      return { accessibility: true, screenRecording: true }
    default:
      return null
  }
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Windows 上自检用的假助手状态 */
const FAKE_WIN_HELPER: WinHelperInfo = {
  pid: 0,
  version: null,
  integrity: 'medium',
  uacEnabled: true,
}

export function createComputerUseSettings(
  controls: ComputerUseControls,
  fake: PermissionStatus | null = null,
): ComputerUseSettings {
  const platform = controls.platform
  /** 这次运行里上一次问到的 */
  let last: PermissionStatus | null = null
  let lastWin: WinHelperInfo | null = null

  async function winStatus(launch: boolean): Promise<ComputerUseState> {
    if (fake)
      return { platform, helper: 'ready', permissions: null, windows: { ...FAKE_WIN_HELPER } }
    if (!launch && !controls.running()) {
      const reason = controls.lastError()
      return {
        platform,
        helper: 'idle',
        permissions: null,
        windows: lastWin,
        ...(reason ? { reason } : {}),
      }
    }
    try {
      const info = await controls.helperInfo(launch)
      if (info) lastWin = info
      return { platform, helper: info ? 'ready' : 'idle', permissions: null, windows: lastWin }
    } catch (error) {
      return {
        platform,
        helper: 'failed',
        permissions: null,
        windows: null,
        reason: reasonOf(error),
      }
    }
  }

  async function status(launch: boolean): Promise<ComputerUseState> {
    if (platform === 'win32') return winStatus(launch)
    if (fake) return { platform, helper: 'ready', permissions: { ...fake } }
    if (!launch && !controls.running()) return { platform, helper: 'idle', permissions: last }
    try {
      const permissions = await controls.permissions()
      last = {
        accessibility: permissions.accessibility,
        screenRecording: permissions.screenRecording,
      }
      return { platform, helper: 'ready', permissions: { ...last } }
    } catch (error) {
      return { platform, helper: 'failed', permissions: null, reason: reasonOf(error) }
    }
  }

  return {
    status,
    async openSettings(pane) {
      if (!isPane(pane) || platform === 'win32') return false
      if (fake) return true
      try {
        return await controls.openPermissionSettings(pane)
      } catch {
        return false
      }
    },
    async restart() {
      if (fake) return status(true)
      try {
        await controls.restartHelper()
      } catch (error) {
        return { platform, helper: 'failed', permissions: null, reason: reasonOf(error) }
      }
      return status(true)
    },
  }
}
