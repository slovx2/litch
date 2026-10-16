// 设置页“内置浏览器”“Computer Use”两节，和设备详情里 Computer Use 开关旁那一句提示，用到的判断。
// 纯函数，单独测（test/settings-tools.test.mjs）；组件只管照着画。
import type { BrowserSavedSite } from '../side/browser/bridge.ts'
import type { AlwaysAllowedApp, ComputerUseState, PermissionPane } from './computer-bridge.ts'

/** 两项系统权限，按这个顺序排 */
export const PANES: readonly PermissionPane[] = ['accessibility', 'screenRecording']

/** 一项权限的样子：给了、没给、不知道（助手没起来，或者还没问过） */
export type PermissionLook = 'granted' | 'missing' | 'unknown'

export function permissionLook(
  state: ComputerUseState | null | undefined,
  pane: PermissionPane,
): PermissionLook {
  const permissions = state?.permissions
  if (!permissions) return 'unknown'
  return permissions[pane] ? 'granted' : 'missing'
}

/**
 * 要不要出“重启助手”：助手在跑而屏幕录制还没给的时候。屏幕录制是进程起来时定的，
 * 用户在系统设置里打开之后，助手要重启才看得到（辅助功能不用，打开就生效，再查一次就行）
 */
export const offersRestart = (state: ComputerUseState | null | undefined): boolean =>
  state?.helper === 'ready' && state.permissions?.screenRecording === false

/** 两项都给了 */
export const allGranted = (state: ComputerUseState | null | undefined): boolean =>
  !!state?.permissions?.accessibility && !!state.permissions.screenRecording

/**
 * 设备详情里 Computer Use 开关旁边那一句：missing 是知道这台 Mac 没给全，unknown 是没问过（不为看一眼去拉起助手），
 * null 是两项都给了，不用说
 */
export function deviceHint(
  state: ComputerUseState | null | undefined,
): 'missing' | 'unknown' | null {
  const permissions = state?.permissions
  if (!permissions) return 'unknown'
  return permissions.accessibility && permissions.screenRecording ? null : 'missing'
}

/** 一张清单现在是什么样：在取、取不到、空的、有东西 */
export type ListPhase = 'loading' | 'failed' | 'empty' | 'list'

export function listPhase(list: readonly unknown[] | null | undefined, failed: boolean): ListPhase {
  if (failed) return 'failed'
  if (!list) return 'loading'
  return list.length === 0 ? 'empty' : 'list'
}

/** “一直允许”的网站：最近允许的在前，同时允许的按来源排 */
export function sortSites(sites: readonly BrowserSavedSite[]): BrowserSavedSite[] {
  return [...sites].sort((a, b) => b.at - a.at || a.origin.localeCompare(b.origin))
}

/** “始终允许”的应用：按名字排，名字一样按包标识 */
export function sortApps(apps: readonly AlwaysAllowedApp[]): AlwaysAllowedApp[] {
  return [...apps].sort(
    (a, b) => a.name.localeCompare(b.name) || a.bundleId.localeCompare(b.bundleId),
  )
}

/** 来源显示成什么：https 的只写主机（加端口），别的照原样 */
export function siteLabel(origin: string): string {
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin
}

/** 日期写成 年-月-日（本地时间）；认不出的时间给空字符串 */
export function dayOf(when: number | string): string {
  const date = new Date(when)
  if (Number.isNaN(date.getTime())) return ''
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}
