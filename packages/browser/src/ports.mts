import type { BrowserDriver } from '../../automation-contracts/src/browser.mjs'
import type { BrowserHandover } from './browser/executor.mjs'
import type { BrowserHost, BrowserPage } from './browser/model.mjs'
import type { SiteBook } from './browser/sites.mjs'

/** CDP 宿主与语义驱动的桥；Chrome 与 Electron 都实现同一 CdpHost。 */
export interface CdpDriverOptions {
  hostId: string
  host: BrowserHost
  /** 可信宿主验证输入的 owner，驱动不会从模型参数学习新的设备身份。 */
  sites: SiteBook
  /** Chrome 的 localhost 也需审批；调用方可注入比默认更严格的判断。 */
  requiresApproval?(url: string): boolean
  statFile?(path: string): { file: boolean; size: number } | null
  /** 与工具执行器共用的脚本标记/登录闸。 */
  browserHandover?: BrowserHandover
  /** 登录冻结由宿主控制，缺钩子时 driver 不宣告登录能力。 */
  handover?: {
    active(pageId: string): boolean
    freeze(pageId: string): Promise<string>
    unfreeze(pageId: string, token: string): Promise<void>
  }
  /** Electron 的存储保存，或 Chrome 自身存储；退出由宿主负责排序。 */
  flushStorage?(signal: AbortSignal): Promise<void>
  onChange?(listener: () => void): () => void
}

export interface BrowserDriverRuntime {
  driver: BrowserDriver
  /** 可信宿主 UI 可显示标签，不把底层页面对象交给模型。 */
  show(pageId: string): void
  dispose(): Promise<void>
}

export type CdpDriverFactory = (options: CdpDriverOptions) => BrowserDriverRuntime

/** 转发不在包里创建 SSH、读取设备表或凭据；由宿主注入 URL 改写。 */
export interface NavigationResolver {
  rewrite(page: BrowserPage, url: string): Promise<string> | null
}

export interface ElectronHostOptions {
  partition: string
  autofillPreload: string
  /** 可选的远端 URL 改写。 */
  navigation?: NavigationResolver
  /** 仅用于导航失败的可信本地说明页。 */
  failurePage(url: string, reason: string): string
  /** 保持宿主自己的产品描述；Litch 接线传入现有文字。 */
  blockedDownload(name: string): string
}
