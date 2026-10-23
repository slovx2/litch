// 工作树（扩展 worktrees，定义在 protocol/extensions/worktrees.json）：设备进程在会话所在的机器上跑 git 建工作树，
// 再把新会话的 cwd 换成工作树里对应的子目录交给引擎，七个 harness 一套做法。
// 客户端在 thread/start 上带 litchWorktree 要一个新工作树；工作树主人的会话对象上挂 litchWorktree；
// 其余的列出、删除、恢复、列分支走下面几个方法。都只对握手时声明了 worktrees 的连接生效。

/** 从哪切：仓库默认分支（本地与 origin 较新的那个）、某个分支、源检出当前的 HEAD、当前本地状态（HEAD 加未提交改动加未跟踪文件） */
export type WorktreeFromKind = 'default' | 'branch' | 'head' | 'working-tree'

export interface WorktreeFrom {
  kind: WorktreeFromKind
  /** kind 为 branch 时的分支：本地分支名或 origin/xxx 这样的远程分支 */
  branch?: string
}

/** thread/start 的扩展参数：建一个新工作树，会话在里面起 */
export interface ThreadStartWorktree {
  /** 不给是 default */
  from?: WorktreeFrom
  /** 起名用的提示（会话标题、第一句话）；不给只用随机串 */
  title?: string
}

/**
 * creating：正在建；ready：在用；kept：主人归档了、里面有未提交的改动，整个留着；
 * removed：目录删了（分支留着，有改动时留了快照），能恢复
 */
export type WorktreeState = 'creating' | 'ready' | 'kept' | 'removed'

export interface Worktree {
  id: string
  /** 建它时用户的那份检出（仓库根） */
  sourceRoot: string
  /** 工作树根目录 */
  path: string
  /** 会话目录相对仓库根的子路径（工作区根不是仓库根时），没有是空串 */
  subPath: string
  branch: string
  /** 从哪切的：分支名，或者 HEAD、working-tree */
  baseRef: string
  baseCommit: string
  /** 主人会话；刚建、会话还没起来时是 null */
  ownerThreadId: string | null
  state: WorktreeState
  /** 删目录前做的快照（refs/litch/snapshots/<id>），没做是 null */
  snapshotRef: string | null
  /** 秒 */
  createdAt: number
  updatedAt: number
}

/** 会话对象上的 litchWorktree：这个会话是哪个设备层工作树的主人 */
export type ThreadWorktree = Pick<
  Worktree,
  'id' | 'path' | 'branch' | 'baseRef' | 'baseCommit' | 'state' | 'sourceRoot'
>

/** 会话对象上我们加的字段 */
export interface WorktreeThreadFields {
  litchWorktree?: ThreadWorktree
}

/** thread/start 参数上我们加的字段 */
export interface WorktreeStartFields {
  litchWorktree?: ThreadStartWorktree
}

export const WORKTREE_METHOD = {
  /** 这台设备上设备层建的全部工作树（不含已经彻底删掉的）。参数空对象，应答 WorktreeListResponse */
  list: 'litch/worktree/list',
  /** 一个检出所在仓库的分支，给“从哪切”用。参数 WorktreeBranchesParams，应答 WorktreeBranchesResponse */
  branches: 'litch/worktree/branches',
  /**
   * 删一个工作树的目录：干净的直接删；有改动时 discard 为真直接丢，否则先做快照再删。分支留着，withBranch 为真才删
   *（有没推送到任何远端的提交时也照删，确认在客户端做）。参数 WorktreeRemoveParams，应答 { worktree }
   */
  remove: 'litch/worktree/remove',
  /** 把删了目录的工作树建回原路径（有快照从快照，没有从分支）。参数 { id }，应答 { worktree } */
  restore: 'litch/worktree/restore',
} as const

/** 工作树变了（建成、主人变了、删了、恢复了）：只发给声明了 worktrees 的连接 */
export const WORKTREE_CHANGED = 'litch/worktree/changed'

export interface WorktreeChangedNotification {
  worktree: Worktree
  /** 连分支一起删掉了：设备上已经没有这条记录 */
  deleted?: boolean
}

export interface WorktreeListResponse {
  data: Worktree[]
}

export interface WorktreeBranchesParams {
  /** 检出里的任一目录 */
  cwd: string
}

export interface WorktreeBranchesResponse {
  /** 当前检出的分支；分离 HEAD 是 null */
  current: string | null
  /** 仓库默认分支（origin/HEAD 指的，没有就 main、master 里有的那个），找不到是 null */
  defaultBranch: string | null
  local: string[]
  /** origin/xxx 这样的远程分支（不含 origin/HEAD） */
  remote: string[]
}

export interface WorktreeRemoveParams {
  id: string
  discard?: boolean
  withBranch?: boolean
}

/** 设置键（Go 层 settings_worktrees.go 声明） */
export const WORKTREE_SETTING = {
  root: 'worktrees.root',
  branchPrefix: 'worktrees.branchPrefix',
  fetchFirst: 'worktrees.fetchFirst',
} as const

export const WORKTREE_DEFAULTS = {
  branchPrefix: 'litch/',
  fetchFirst: false,
} as const

/** 快照引用的前缀 */
export const WORKTREE_SNAPSHOT_REF = 'refs/litch/snapshots/'
