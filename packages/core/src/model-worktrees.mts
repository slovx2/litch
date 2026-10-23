// 设备层工作树（协议扩展 worktrees）在界面这一头的样子。
// 建、删、恢复、快照都在设备上（设备进程跑 git），核心只是转运：
// - 新建会话时带上“在新工作树里建”（session.create 的 worktree），设备建好工作树再起会话；
// - 会话摘要上的 worktree 来自会话对象的 litchWorktree，跟着 litch/worktree/changed 更新；
// - worktrees 主题是这台设备上设备层建的全部工作树（设置页的列表），开着时才去读。
import type { WorktreeFrom, WorktreeState } from '../../protocol/src/worktrees.mjs'
import type { ChannelErrorShape } from './channel/protocol.mjs'

export type { WorktreeFrom, WorktreeState }

/** 会话所在的那个设备层工作树（会话摘要上的 worktree） */
export interface SessionWorktreeView {
  id: string
  /** 工作树根目录（设备上的绝对路径） */
  path: string
  branch: string
  /** 从哪切的：分支名、HEAD，或者 working-tree（当前本地状态） */
  baseRef: string
  baseCommit: string
  state: WorktreeState
  /** 建它时用户的那份检出（仓库根） */
  sourceRoot: string
}

/** 设置页列表里的一项 */
export interface WorktreeView extends SessionWorktreeView {
  /** 会话目录相对仓库根的子路径，没有是空串 */
  subPath: string
  /** 主人会话；刚建、会话还没起来时是 null */
  ownerSessionId: string | null
  /** 删目录前做的快照；没做是 null */
  snapshotRef: string | null
  /** 毫秒 */
  createdAt: number
  updatedAt: number
}

/** 一个检出所在仓库的分支（新建页“从哪切”用） */
/** 合入基础分支的结果：merged 合进来了、upToDate 没有新提交、conflicts 停在冲突状态（files 是冲突的文件） */
export interface WorktreeSyncView {
  status: 'merged' | 'upToDate' | 'conflicts'
  files: string[]
}

export interface WorktreeBranchesView {
  /** 当前检出的分支；分离 HEAD 是 null */
  current: string | null
  /** 仓库默认分支；找不到是 null */
  defaultBranch: string | null
  local: string[]
  /** origin/xxx */
  remote: string[]
}

/**
 * worktrees 主题的快照：一台设备上设备层建的全部工作树。
 * available：设备列没列 worktrees。还没连上过是 null；false 时设置页不出这一块
 */
export interface WorktreesTopicView {
  deviceId: string
  available: boolean | null
  /** 还没读到（没连上、不支持、正在读）是 null */
  list: WorktreeView[] | null
  loading: boolean
  /** 上一次读没读成的原因。读成了清掉 */
  error: ChannelErrorShape | null
}
