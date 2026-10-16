// 文件面板看到的数据形状：一层目录、一个文件的内容、找文件的结果，以及界面画文件树用的行。
// 路径都是对面那台机器上的绝对路径，已经理成最简的样子（text/paths.mts）。
import type { ChannelErrorShape } from './channel/protocol.mjs'

/** other：既不是目录也不是普通文件，或者是没去问过指向哪儿的符号链接 */
export type FileEntryKind = 'dir' | 'file' | 'other'

export interface FileEntry {
  name: string
  kind: FileEntryKind
}

/** 一层目录。目录在前，同类按名字排；隐藏的（名字以点开头）也在里面，显不显示由界面定 */
export interface DirectoryView {
  path: string
  entries: FileEntry[]
  /** 这一层实际有多少项。比 entries 多就是太多了、后面的没给 */
  total: number
}

/**
 * 不按文字显示的文件是哪一类，界面按它说占位的那句话。
 * binary：读了才发现里面不是文字；别的是看扩展名认的，没有去读
 */
export type FileGroup =
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'document'
  | 'font'
  | 'database'
  | 'executable'
  | 'binary'

export type FileContent =
  | {
      kind: 'text'
      path: string
      text: string
      /** 文件多少字节 */
      bytes: number
      /** 上色用的语言（上色库认的名字）。认不出来是 null，照原样显示 */
      language: string | null
      /** 里面有不是 UTF-8 的字节，显示出来的字有替换过的 */
      lossy: boolean
    }
  /** 太大了，不显示。limit 是能显示的上限 */
  | { kind: 'tooLarge'; path: string; bytes: number; limit: number }
  /** 不是文字。bytes 为 null：是按扩展名认的，没有去读 */
  | { kind: 'binary'; path: string; group: FileGroup; bytes: number | null }
  | { kind: 'directory'; path: string }
  | { kind: 'missing'; path: string }

export interface FileMatch {
  /** 完整路径 */
  path: string
  /** 相对于工作区根的路径，显示用 */
  relative: string
  kind: 'dir' | 'file'
  /** relative 里对上了的字符的位置（按 Unicode 字符数）。对面没给是 null */
  indices: number[] | null
}

export interface FileSearchView {
  query: string
  matches: FileMatch[]
}

/**
 * 文件树里的一行。树是摊平了给界面的：界面只画看得见的那几十行。
 * 除了目录和文件，还有几种说明行，跟在它所属的目录下面：
 * loading（这一层正在取）、failed（没取到）、empty（空目录，或者里面只有隐藏的）、truncated（太多了，后面的没显示）
 */
export interface FileRow {
  /** 行的标识。目录和文件就是路径；说明行是所属目录的路径后面跟一个记号 */
  id: string
  /** 目录和文件自己的路径；说明行是它所属目录的路径 */
  path: string
  name: string
  depth: number
  kind: FileEntryKind | 'loading' | 'failed' | 'empty' | 'truncated'
  /** 目录：展开着没有 */
  expanded: boolean
  /** failed：原因；truncated：没显示的有多少项。别的行没有 */
  note: FileRowNote | null
}

export type FileRowNote =
  | { kind: 'failed'; error: ChannelErrorShape }
  | { kind: 'truncated'; hidden: number }

/** 一棵文件树（一台设备上的一个根）现在什么状况 */
export interface FileTreeState {
  /** loading：根目录还没取到；failed：根目录没取到 */
  phase: 'loading' | 'ready' | 'failed'
  error: ChannelErrorShape | null
  /** 正在重新取（刷新）。界面上转一下 */
  refreshing: boolean
}
