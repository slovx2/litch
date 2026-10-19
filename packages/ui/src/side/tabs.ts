// 侧面板里有哪些标签。加一个标签只是在下面的表里登记一行：标识、标签上的字、图标、内容从哪装载。
// 面板的框架（开合、宽度、标签栏、窄窗口让位）不认识任何一个具体的标签。
import { type ComponentType, type LazyExoticComponent, lazy } from 'react'
import type { IconName } from '../app/icons.tsx'
import type { MessageKey } from '../i18n/index.ts'
// 内置浏览器：代理要给人看网页时打开面板（启动时就装上，见 browser/show.ts）
import './browser/show.ts'
import { AGENTS_TAB } from '../tree/agents.ts'
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
    // 引擎自己派出的子代理：对话里点子代理卡片时打开（tree/agents.ts 的 openAgent）
    id: AGENTS_TAB,
    label: 'side.tab.agents',
    icon: 'agents',
    Panel: lazy(() =>
      import('../tree/AgentsTab.tsx').then((module) => ({ default: module.AgentsTab })),
    ),
  },
]
