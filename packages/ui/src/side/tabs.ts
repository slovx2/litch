// 侧面板里有哪些标签。加一个标签只是在下面的表里登记一行：标识、标签上的字、图标、内容从哪装载。
// 面板的框架（开合、宽度、标签栏、窄窗口让位）不认识任何一个具体的标签。
import { type ComponentType, type LazyExoticComponent, lazy } from 'react'
import type { IconName } from '../app/icons.tsx'
import type { MessageKey } from '../i18n/index.ts'
// 内置浏览器：代理要给人看网页时打开面板（启动时就装上，见 browser/show.ts）
import './browser/show.ts'
import { ASIDE_TAB } from '../aside/tab.ts'
import { BACKGROUND_TAB } from '../background/tab.ts'
import { GOAL_TAB } from '../goal/tab.ts'
import { BROWSER_TAB } from './browser/store.ts'

/**
 * 面板现在挂在哪：眼前的会话（或者正在写的新会话）所在的设备和工作区。
 * 换会话就换地方；各个标签自己的状态按地方记，回来的时候还在。
 */
export interface SidePlace {
  deviceId: string
  /** null：不属于任何工作区 */
  workspaceId: string | null
  /**
   * 这个地方的根目录：工作区的各个根；不属于工作区的会话是它的工作目录。
   * 一个都没有（在“无工作区”里写新会话）就是空的
   */
  roots: readonly string[]
  /** 眼前会话的工作目录：对话里的相对路径相对于它。正在写的新会话还没有，是 null */
  cwd: string | null
  /** 眼前的会话。正在写的新会话还没有，是 null。差异标签用它认“这个会话最近一个回合的改动” */
  sessionId: string | null
}

export interface SideTabProps {
  place: SidePlace
  /** 面板现在是不是显示着。收起来、或者在没有侧面板的页面上时是 false：要花设备力气的事这时候别做 */
  shown: boolean
}

export interface SideTabSpec {
  /** 标签的标识：记“上次看的是哪个标签”用它，别处要打开这个标签也用它（showSideTab） */
  id: string
  /** 标签上的字 */
  label: MessageKey
  icon: IconName
  /** 标签的内容。用到的时候才装载，不在启动要读的那一包里 */
  Panel: LazyExoticComponent<ComponentType<SideTabProps>>
  /** 标签上的角标（比如等着的个数）。没有就不画；跟着标签栏一直在，也是用到的时候才装载 */
  Badge?: LazyExoticComponent<ComponentType<{ place: SidePlace }>>
  /**
   * 眼前会话的 harness 得会这件事才出这个标签（SessionAbilities 里的那一位）。不给就一直在。
   * 不会的时候标签栏上没有它；面板正停在它上面时照常画，内容自己说做不了
   */
  needs?: 'goals' | 'sideChat'
}

export const FILES_TAB = 'files'
export const DIFF_TAB = 'diff'
export const PROPOSALS_TAB = 'proposals'

export const SIDE_TABS: readonly SideTabSpec[] = [
  {
    id: FILES_TAB,
    label: 'side.tab.files',
    icon: 'tree',
    Panel: lazy(() =>
      import('../files/FilesTab.tsx').then((module) => ({ default: module.FilesTab })),
    ),
  },
  {
    id: DIFF_TAB,
    label: 'side.tab.diff',
    icon: 'diff',
    Panel: lazy(() =>
      import('../diff/DiffTab.tsx').then((module) => ({ default: module.DiffTab })),
    ),
  },
  {
    id: BROWSER_TAB,
    label: 'side.tab.browser',
    icon: 'globe',
    Panel: lazy(() =>
      import('./browser/BrowserTab.tsx').then((module) => ({ default: module.BrowserTab })),
    ),
  },
  {
    // 模型提的建议任务（子会话提案）：等着的、了结的都在这里，点一条跳到对话里那张卡片
    id: PROPOSALS_TAB,
    label: 'side.tab.proposals',
    icon: 'suggest',
    Panel: lazy(() =>
      import('../tree/ProposalsTab.tsx').then((module) => ({ default: module.ProposalsTab })),
    ),
    Badge: lazy(() =>
      import('../tree/ProposalsBadge.tsx').then((module) => ({ default: module.ProposalsBadge })),
    ),
  },
  {
    // 后台任务：回合结束后还在跑的命令、引擎自己的子代理、会话树里的子会话合在一页，选中子代理时下面是子代理页。
    // 输入框上方那一行、对话里的子代理卡片点了打开（background/tab.ts）
    id: BACKGROUND_TAB,
    label: 'side.tab.background',
    icon: 'loop',
    Panel: lazy(() =>
      import('../background/BackgroundTab.tsx').then((module) => ({
        default: module.BackgroundTab,
      })),
    ),
  },
  {
    // 持续目标：输入框上方那一行点了打开（goal/tab.ts），看、改、暂停、清除。harness 不会的不出
    id: GOAL_TAB,
    label: 'side.tab.goal',
    icon: 'target',
    needs: 'goals',
    Panel: lazy(() =>
      import('../goal/GoalTab.tsx').then((module) => ({ default: module.GoalTab })),
    ),
  },
  {
    // 侧聊：从眼前会话临时分出的一段对话（aside/state.ts）。选字浮层的“侧聊”也打开它。harness 不会的不出
    id: ASIDE_TAB,
    label: 'side.tab.aside',
    icon: 'aside',
    needs: 'sideChat',
    Panel: lazy(() =>
      import('../aside/AsideTab.tsx').then((module) => ({ default: module.AsideTab })),
    ),
  },
  {
    id: 'automationPreview',
    label: 'automation.tab',
    // 目标那一页用了 target，这里用屏幕，两个标签一眼分得开
    icon: 'machine',
    Panel: lazy(() =>
      import('../automation-preview/PreviewTab.tsx').then((module) => ({
        default: module.PreviewTab,
      })),
    ),
  },
]
