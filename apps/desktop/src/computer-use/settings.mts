// 设置页里 Computer Use 那一节在主进程这一侧要的几件事：助手和两项系统权限的状态、打开系统设置对应的那一页、
// 重启助手、“始终允许”的清单。界面经预加载脚本的 window.litchComputerUse 调，消息在 main.mts 里登记
// （只认界面自己的主框架发来的）。这里不引 electron，方便测试。
//
// 查权限要助手在跑。launch 为真（用户打开了设置页的那一节）时，助手没在跑就拉起它；为假（设备详情里顺带看一眼）时
// 不拉起：只问在跑的那个，没在跑就回这次运行里上一次问到的（一次都没问过是 null）。权限只用助手那头不弹窗的检查
// （AXIsProcessTrusted、CGPreflightScreenCaptureAccess），这里不碰系统设置，也不替用户授权。
//
// LITCH_COMPUTER_USE_PERMISSIONS 是给自检和截图用的：设了就不碰助手，权限照它说的回
// （none、accessibility、screenRecording、both），打开系统设置、重启助手都只当作做了。
import type { AlwaysAllowedApp } from './approvals.mjs'
import type { PermissionStatus } from './wire.mjs'

export type PermissionPane = 'accessibility' | 'screenRecording'

export interface ComputerUseState {
  /** ready：助手在跑、刚问过；idle：没在跑，没去拉起；failed：拉起或问的时候出错了 */
  helper: 'ready' | 'idle' | 'failed'
  /** 两项权限。idle 时是上一次问到的，没问过是 null；failed 时是 null */
  permissions: PermissionStatus | null
  /** failed 时的原因（原话） */
  reason?: string
}

/** 要用到的 Computer Use 的几样（computer-use/index.mts 返回的对象上都有，running 由调用方从 supervisor 算） */
export interface ComputerUseControls {
  /** 查两项权限（会拉起助手） */
  permissions(): Promise<PermissionStatus>
  /** 助手现在在不在跑（不拉起） */
  running(): boolean
  openPermissionSettings(pane: PermissionPane): Promise<boolean>
  restartHelper(): Promise<void>
  listAlwaysAllowed(): AlwaysAllowedApp[]
  removeAlwaysAllowed(bundleId: string): boolean
}

export interface ComputerUseSettings {
  status(launch: boolean): Promise<ComputerUseState>
  openSettings(pane: unknown): Promise<boolean>
  restart(): Promise<ComputerUseState>
  apps(): AlwaysAllowedApp[]
  forgetApp(bundleId: unknown): boolean
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

export function createComputerUseSettings(
  controls: ComputerUseControls,
  fake: PermissionStatus | null = null,
): ComputerUseSettings {
  /** 这次运行里上一次问到的 */
  let last: PermissionStatus | null = null

  async function status(launch: boolean): Promise<ComputerUseState> {
    if (fake) return { helper: 'ready', permissions: { ...fake } }
    if (!launch && !controls.running()) return { helper: 'idle', permissions: last }
    try {
      const permissions = await controls.permissions()
      last = {
        accessibility: permissions.accessibility,
        screenRecording: permissions.screenRecording,
      }
      return { helper: 'ready', permissions: { ...last } }
    } catch (error) {
      return { helper: 'failed', permissions: null, reason: reasonOf(error) }
    }
  }

  return {
    status,
    async openSettings(pane) {
      if (!isPane(pane)) return false
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
        return { helper: 'failed', permissions: null, reason: reasonOf(error) }
      }
      return status(true)
    },
    apps: () => controls.listAlwaysAllowed(),
    forgetApp: (bundleId) =>
      typeof bundleId === 'string' && bundleId !== '' && controls.removeAlwaysAllowed(bundleId),
  }
}
