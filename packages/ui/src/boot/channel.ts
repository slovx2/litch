// 取得通往核心的通道。两种情况：
// 在桌面外壳里：向外壳要一个消息端口，对面是核心进程；
// 在普通浏览器里：没有外壳，就在本页面里起一个模拟核心，用同线程的端口对连上。
import {
  type Clock,
  type CoreChannel,
  connectChannel,
  createMockCore,
  createPortPair,
  type Port,
  serveChannel,
} from '@litch/core'

/** 桌面外壳的预加载脚本挂在 window 上的东西。只有这几项，没有别的权限 */
export interface ShellBridge {
  kind: 'electron'
  platform: string
  /** 请外壳把一个连着核心的消息端口发到这个页面来 */
  requestCorePort(): void
  /** 请外壳用系统的浏览器打开一个网址。外壳只接受 http 和 https */
  openExternal(url: string): void
  /** 用系统的文件管理器打开日志目录：desktop 是桌面端自己的，device 是本机设备服务的 */
  openLogs?(which: 'desktop' | 'device'): void
  /** 告诉外壳界面现在用的是哪种语言，应用菜单跟着换 */
  setLanguage(lang: 'zh-CN' | 'en'): void
  /** 用户选中、拖进来、贴进来的一个文件在磁盘上的位置。不是从磁盘来的是空的 */
  pathOf(file: File): string
  /** 应用菜单里点了要界面来办的一项（比如开合终端）。返回的函数用来不再听 */
  onMenu?(handler: (action: string) => void): () => void
  /**
   * 告诉外壳现在的皮肤、明暗、缩放。缩放是外壳做的（按这个倍数缩放整个页面，窗口的最小尺寸跟着走）；
   * 三样它都记着，下次冷启动时窗口在页面画出来之前的底色和缩放就按它们来
   */
  setLook(look: { skin: string; theme: string; zoom: number }): void
  /** Dock 上的角标数（要人看一眼的会话有几个，0 是不显示） */
  setBadge?(count: number): void
  /** 发一条系统通知（定时任务跑完了、会话回合结束或要人处理）。id 是自己认的，点了从 onNotifyClick 原样回来 */
  notify?(notice: { id: string; title: string; subtitle?: string; body: string }): void
  /** 用户点了哪一条系统通知。返回的函数用来不再听 */
  onNotifyClick?(handler: (id: string) => void): () => void
  /** 应用的名字、版本，和应用里带着哪些许可文本 */
  about(): Promise<ShellAbout>
  /** 取一份许可文本的全文。id 是 about() 给的；没有这一份是 null */
  licenseText(id: string): Promise<string | null>
  /**
   * 弹系统的选文件夹对话框，回选中的目录（取消了是 null）。只对本机的设备有意义：
   * 选出来的是这台电脑上的路径。defaultPath 是从哪里开始找
   */
  pickFolder?(options: { defaultPath?: string; title?: string }): Promise<string | null>
  /** 告诉外壳现在有没有没保存的改动：有的话关窗口、退出之前它先拦下来，请界面问（onLeaveAsk） */
  setUnsaved?(unsaved: boolean): void
  /** 外壳拦下了关窗口、退出，请界面问“保存 / 放弃 / 取消”。返回的函数用来不再听 */
  onLeaveAsk?(handler: () => void): () => void
  /** 问完了可以走（保存成了或者放弃了）：外壳接着关窗口、退出 */
  leaveGo?(): void
}

/** 一份能在应用里看的许可文本 */
export interface LicenseEntry {
  /** 取全文时用的标识 */
  id: string
  /** 包名；本项目自己的两份没有版本 */
  name: string
  version: string
  /** 声明的许可（MIT、OFL-1.1 这类标识） */
  license: string
}

export interface ShellAbout {
  name: string
  version: string
  /** 外壳用的运行时 */
  electron: string
  chrome: string
  /** 本项目的许可证、第三方声明：应用里带着就有这一项 */
  project: LicenseEntry | null
  notices: LicenseEntry | null
  /**
   * 打进应用的第三方代码各自的许可文本。null：这一份应用里没有带（没打包的开发版本，逐包的文本是打包时才收的）
   */
  packages: LicenseEntry[] | null
}

declare global {
  interface Window {
    litchShell?: ShellBridge
  }
}

const PORT_MESSAGE = 'litch:core-port'

export const browserClock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

function fromMessagePort(port: MessagePort): Port {
  return {
    post: (message) => port.postMessage(message),
    listen(handler) {
      port.onmessage = (event) => handler(event.data)
    },
    close: () => port.close(),
  }
}

function waitForShellPort(shell: ShellBridge): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      // 只认本页面自己转进来的那一条，并且必须带着端口
      if (event.source !== window || event.data?.type !== PORT_MESSAGE) return
      const port = event.ports[0]
      if (!port) return
      window.removeEventListener('message', onMessage)
      resolve(port)
    }
    window.addEventListener('message', onMessage)
    shell.requestCorePort()
  })
}

export interface Boot {
  channel: CoreChannel
  shell: 'electron' | 'browser'
}

/** lang：在浏览器里起模拟核心时，示例数据用哪种语言 */
export async function openChannel(lang: 'zh-CN' | 'en'): Promise<Boot> {
  const shell = window.litchShell
  if (shell) {
    const port = await waitForShellPort(shell)
    return { channel: connectChannel(fromMessagePort(port)), shell: 'electron' }
  }
  const [uiPort, corePort] = createPortPair()
  serveChannel(corePort, createMockCore({ clock: browserClock, lang }), { clock: browserClock })
  return { channel: connectChannel(uiPort), shell: 'browser' }
}
