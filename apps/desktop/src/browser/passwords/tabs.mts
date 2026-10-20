// 哪些标签挂自动填充的预加载：只有用户自己开的（kind === 'user'）。electron-tab.mts 建视图时用这里的两样：
// 网页设置里加的预加载（各个框架都跑一份，好让跨源子框架按它自己的源填），和登记“这是用户标签”。
// 主进程收到自动填充的消息先查登记（autofill.mts），代理的标签发来的一律不认。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebContents, WebPreferences } from 'electron'
import type { TabKind } from '../model.mjs'

/** 和主进程的产物在同一个目录（scripts/build.mjs 打出来的） */
const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'autofill-preload.cjs')

const userTabs = new Set<number>()

/**
 * 用户标签多出来的网页设置。nodeIntegrationInSubFrames 在开了沙箱的视图上只是让预加载也在子框架里跑，
 * 不会给任何框架 Node；预加载在隔离环境里，网页碰不到它
 */
export function autofillPreferences(kind: TabKind): WebPreferences {
  return kind === 'user' ? { preload: PRELOAD, nodeIntegrationInSubFrames: true } : {}
}

/** 建好视图之后登记；视图销毁时自己撤掉 */
export function registerAutofillTab(contents: WebContents, kind: TabKind): void {
  if (kind !== 'user') return
  const id = contents.id
  userTabs.add(id)
  contents.once('destroyed', () => userTabs.delete(id))
}

export const isAutofillTab = (contentsId: number): boolean => userTabs.has(contentsId)
