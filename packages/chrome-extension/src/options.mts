import type { ChromeHostIdentity } from '../../automation-contracts/src/chrome.mjs'

/** 仅接受宿主编译/可信入口提供的配置，不从网页或模型参数读取。 */
export interface ExtensionOptions {
  chrome: any
  identity: ChromeHostIdentity
  protocol: { min: number; max: number }
  storagePrefix: string
  /** 同包 pointer-world 入口构建出的 IIFE 文本，执行在 isolated world。 */
  pointerSource: string
}
