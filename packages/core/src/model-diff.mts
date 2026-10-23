// 差异面板看到的数据形状：有哪些文件变了（各自什么状态、增删多少行），和一个文件具体改了什么。
// 路径都相对于面板的根（工作区的根；不属于工作区的会话是它的工作目录），用斜杠分隔。
import type { ChannelErrorShape } from './channel/protocol.mjs'

/**
 * 拿什么和什么比。
 * all：全部没提交的（上一次提交对工作区，没跟踪的新文件也算）；
 * staged：已经暂存的（上一次提交对暂存区）；
 * unstaged：还没暂存的（暂存区对工作区，没跟踪的新文件也算）
 */
export type DiffScope = 'all' | 'staged' | 'unstaged'

export const DIFF_SCOPES: readonly DiffScope[] = ['all', 'staged', 'unstaged']

export type DiffStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  /** 没跟踪的新文件（或者一整个没跟踪的目录，见 DiffEntry.dir） */
  | 'untracked'
  /** 种类变了：普通文件变成了符号链接之类 */
  | 'typeChanged'
  /** 合并没合完，两边的改动冲突着 */
  | 'conflicted'

export interface DiffEntry {
  /** 相对于根的路径。改了名的是新名字 */
  path: string
  /** 改名、复制之前叫什么。别的状态是 null */
  from: string | null
  status: DiffStatus
  /** 加了、删了多少行。null：不是文字，或者没去数（没跟踪的文件太多的时候） */
  added: number | null
  removed: number | null
  binary: boolean
  /** 权限位变了：旧的、新的（100644 这样的写法）。没变是 null */
  mode: { from: string; to: string } | null
  /** 暂存区里有它的改动 */
  staged: boolean
  /** 工作区里有它还没暂存的改动（没跟踪的也算） */
  unstaged: boolean
  /** 是一整个没跟踪的目录：没跟踪的文件多到列不过来的时候，按目录合成一条，里面的不逐个列 */
  dir: boolean
}

/**
 * 为什么这里看不了 git 的差异。
 * notRepo：这个目录不在 git 仓库里；noGit：那台设备上没有 git；unsupported：对面不会替我们跑命令
 */
export type DiffAbsence = 'notRepo' | 'noGit' | 'unsupported'

/** 一个根（加上比的范围）现在的差异概况。界面订阅它，变了核心会推 */
export interface DiffView {
  /**
   * loading：还没取到；ready：entries 是现在的；
   * absent：这里没有可看的差异（原因在 why）；failed：取的时候出了错（原因在 error）
   */
  phase: 'loading' | 'ready' | 'absent' | 'failed'
  /**
   * 数据是哪来的。git：工作目录的 git 状态；
   * turn：harness 给的本回合差异（看不了 git 的时候才用它，这时 why 说的是为什么没用 git）
   */
  source: 'git' | 'turn'
  why: DiffAbsence | null
  error: ChannelErrorShape | null
  /** 正在重新取 */
  refreshing: boolean
  /** 每取到一份新的就加一。界面按它知道手里的差异内容是不是旧的 */
  version: number
  /** 现在在哪个分支上。游离着、还没取到、不是 git 来源都是 null */
  branch: string | null
  /** 按路径排好了 */
  entries: DiffEntry[]
  /** 变了的文件多到没全列出来：没列的还有多少个。0 是全列了 */
  omitted: number
  /** 对面盯不盯得住文件的变化。盯不住的时候只在回合结束、这边自己动过、手动刷新时更新 */
  watching: boolean
  /** 能不能暂存、取消暂存、还原：只有 git 来源能 */
  writable: boolean
  /**
   * “全部”对着哪个提交算：设备层工作树里的会话是它的起点（和基础分支最近的共同祖先，合入过基础分支也只算这个会话改的），
   * 已经提交了的改动也在里面；别的是 null（上一次提交）
   */
  since: string | null
}

/** 一段连着的改动，连同它前后的几行上下文 */
export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** “@@ … @@” 后面那一段（多半是所在的函数名）。没有是空串 */
  section: string
  /** 一行一个。头一个字是记号：空格是两边都有的，+ 是新加的，- 是删掉的；后面是这一行的字 */
  lines: string[]
}

export interface FileDiff {
  path: string
  from: string | null
  /**
   * text：hunks 里是内容；binary：不是文字，没有内容可看；
   * empty：内容没变（只改了名字或权限），或者是个空文件；
   * tooLarge：差异太大，没有取全，不显示；directory：是一整个没跟踪的目录；
   * missing：现在没有这个文件的差异了（刚被还原或提交了，概况还没跟上）
   */
  kind: 'text' | 'binary' | 'empty' | 'tooLarge' | 'directory' | 'missing'
  hunks: DiffHunk[]
  /** 这一份带着整个文件当上下文（展开上下文时取的）。平常只带改动前后各三行 */
  full: boolean
  /** 上色用的语言（上色库认的名字）。认不出来是 null */
  language: string | null
  /** 旧的那一版、新的那一版末尾没有换行 */
  noEolOld: boolean
  noEolNew: boolean
  added: number
  removed: number
}

/** 一次取回来的全部文件的差异 */
export interface DiffBundle {
  /** 取的时候概况是哪一版（DiffView.version） */
  version: number
  files: FileDiff[]
  /** 合起来太大，没有取全：界面改成一次只看一个文件 */
  truncated: boolean
}

/** 给验收量的：差异模块这次运行里在设备上起过多少次 git、概况取过多少遍 */
export interface DiffRequests {
  spawns: number
  refreshes: number
  /** 各种命令各起过几次（status、diff、grep 这些） */
  byKind: Record<string, number>
}
