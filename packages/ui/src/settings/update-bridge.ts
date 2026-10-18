// 桌面外壳的预加载脚本挂在 window.litchUpdate 上的应用更新接口（apps/desktop/src/preload.mts，
// 主进程那一侧在 apps/desktop/src/main.mts 和 updater.mts），这里是界面这边的类型，改一边要改另一边。
// 普通浏览器里没有它，“关于”里就不显示更新那一块。
import type { UpdateState } from '@litch/core'

export interface UpdateView {
  /** 这台机器出不出更新：没打包的开发版本、清单里没有这个平台的（Linux、Intel 的 Mac）都是 false */
  supported: boolean
  /** 设置里“自动检查更新”开着没有 */
  auto: boolean
  state: UpdateState
}

export interface UpdateBridge {
  get(): Promise<UpdateView | null>
  /** 现在查一次，回查完的样子（查到了新版本时它还在下，之后的变化从 onState 来） */
  check(): Promise<UpdateView | null>
  /** 重启以更新。先照退出的规矩问终端怎么办，用户点了“不退了”回 false */
  install(): Promise<boolean>
  setAuto(on: boolean): Promise<UpdateView | null>
  /** 状态变了。回一个取消订阅的函数 */
  onState(handler: (state: UpdateState) => void): () => void
}

declare global {
  interface Window {
    litchUpdate?: UpdateBridge
  }
}

/** 外壳给的接口。不在桌面外壳里、或者不在页面里（单元测试直接在 Node 里读源文件）时没有 */
export const updateBridge = (): UpdateBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.litchUpdate
