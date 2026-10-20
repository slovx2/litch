// 标签和自动填充的预加载：用户开的、代理开的标签都挂（各个框架都跑一份，好让跨源子框架按它自己的源填）。
// electron-tab.mts 建视图时用这里的两样：网页设置里加的预加载，和登记“这是哪种标签、怎么取它的样子、怎么给代理留提示”。
// 主进程收到自动填充、保存提示的消息先查登记（autofill.mts），没登记过的一律不认。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WebContents, WebPreferences } from 'electron'
import type { TabInfo, TabKind } from '../model.mjs'

/** 和主进程的产物在同一个目录（scripts/build.mjs 打出来的） */
const PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'autofill-preload.cjs')

export interface AutofillTab {
  kind: TabKind
  /** 标签现在的样子（编号、归哪个会话） */
  info(): TabInfo
  /** 给代理留一句提示（下一次工具结果里带上） */
  notice(text: string): void
}

const tabs = new Map<number, AutofillTab>()

/**
 * 标签多出来的网页设置。nodeIntegrationInSubFrames 在开了沙箱的视图上只是让预加载也在子框架里跑，
 * 不会给任何框架 Node；预加载在隔离环境里，网页碰不到它
 */
export function autofillPreferences(): WebPreferences {
  return { preload: PRELOAD, nodeIntegrationInSubFrames: true }
}

/** 建好视图之后登记；视图销毁时自己撤掉 */
export function registerAutofillTab(contents: WebContents, tab: AutofillTab): void {
  const id = contents.id
  tabs.set(id, tab)
  contents.once('destroyed', () => tabs.delete(id))
}

export const autofillTab = (contentsId: number): AutofillTab | undefined => tabs.get(contentsId)
