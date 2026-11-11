// 内置浏览器里执行器和“页面的宿主”之间的约定。执行器（executor.mts）只认这里的接口，不碰 Electron：
// 真的宿主是 electron-host.mts（WebContentsView 加 webContents.debugger），单元测试用假的。

import type { BrowserDownloads } from './downloads.mjs'

/** 标签归哪个会话。会话还没建（新建对话页上用户自己开的）时 threadId 是空字符串 */
export interface TabOwner {
  deviceId: string
  threadId: string
}

/** agent：代理开的（回合结束时关，留给用户的除外）；user：用户自己在面板里开的（代理只能看地址和标题） */
export type TabKind = 'agent' | 'user'

/** 给界面和 tabs 工具的一个标签的样子 */
export interface TabInfo {
  id: string
  owner: TabOwner
  kind: TabKind
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** 代理这个回合正在用它：标签上出“代理在用”的记号 */
  agentActive: boolean
  /** 代理标了“留给用户”：回合结束不关 */
  keep: boolean
}

/** 网页开着的对话框（alert、confirm、prompt、beforeunload） */
export interface DialogInfo {
  type: string
  message: string
  defaultPrompt: string
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug'
  text: string
  /** 出处：脚本地址和行号 */
  source: string
  at: number
}

export interface LoadOutcome {
  ok: boolean
  /** 没加载成的原因（网络错误、被拦下……） */
  error?: string
}

/** 一个标签的页面 */
export interface BrowserPage {
  readonly id: string
  info(): TabInfo
  /** 打开一个地址，等它加载完（或者出错、超时） */
  load(url: string, timeoutMs: number): Promise<LoadOutcome>
  history(action: 'back' | 'forward' | 'reload', timeoutMs: number): Promise<LoadOutcome>
  /** 等页面加载完。回 false 是超时 */
  waitForLoad(timeoutMs: number, signal: AbortSignal): Promise<boolean>
  /** 发一条 CDP 命令。只许白名单里的（cdp-allow.mts），名单外的抛 CdpRefused。需要时自动挂上调试器 */
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** 取消后仅丢弃本次上传的临时对象，不派发输入。 */
  discardUpload?(state: string | undefined, objects: readonly string[]): Promise<void>
  /** 先订阅再开启拦截；dispose 只撤销本次拦截，即使调用已取消也必须清理。 */
  interceptFileChooser?(signal: AbortSignal): Promise<FileChooserInterception>
  /** 已派发输入后重建观察基线；只准恢复读操作，不能重放原输入。来源/租约检查照旧。 */
  prepareObservation?(): Promise<void>
  /** 最近的控制台消息（最多留 200 条） */
  consoleEntries(): ConsoleEntry[]
  clearConsole(): void
  /** 现在开着的对话框；没有是 null */
  dialog(): DialogInfo | null
  /** 下一个对话框开起来时兑现（已经开着就马上兑现）；用来不让一次点击卡在对话框上 */
  dialogOpened(): Promise<DialogInfo>
  /** 攒下来的提示（被拦下的跳转、下载，被改成新标签的弹窗……），取了就清掉 */
  takeNotices(): string[]
  /** 代理开始或停止用它：开着时标签上出记号、不节流、跳转要经过审批 */
  setAgentActive(active: boolean): void
  /** 代理要在 (x, y) 动手了：画一下给人看（CSS 像素） */
  pointAt(x: number, y: number, width?: number, height?: number): Promise<void>
}

export interface FileChooserInfo {
  backendNodeId?: number | undefined
  mode: string
}

export interface FileChooserInterception {
  wait(timeoutMs: number): Promise<FileChooserInfo | null>
  dispose(): Promise<void>
}

export interface OpenOptions {
  url?: string
  keep?: boolean
}

/** 管所有标签的宿主 */
export interface BrowserHost {
  /** Electron 宿主的受控下载队列；纯页面测试宿主没有文件系统能力。 */
  downloads?: BrowserDownloads
  pages(): BrowserPage[]
  page(id: string): BrowserPage | undefined
  /** 开一个新标签（先是空白页，url 给了再去加载由调用的人来） */
  open(owner: TabOwner, kind: TabKind, options?: OpenOptions): BrowserPage
  close(id: string): void
  setKeep(id: string, keep: boolean): void
  /** 回合结束：断开调试器，撤掉代理在用的记号 */
  release(id: string): void
  /** 让界面打开浏览器面板、显示这个标签 */
  show(id: string): void
  /**
   * 代理在用的标签上，网页自己发起的跳转（点链接、脚本改地址、服务器重定向）要不要放行。
   * 执行器装上它：没审批过的来源一律拦下，提示模型用 navigate 去开（那里会问用户）
   */
  setNavigationGate(gate: (page: BrowserPage, url: string) => boolean): void
}
