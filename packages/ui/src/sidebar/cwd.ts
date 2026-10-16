// 会话的工作目录和它所在工作区的根是不是一回事。不是的时候侧栏那一行上出一个小记号。
// 只比字符串，不碰文件系统：目录是设备给的，在哪台机器上、是什么系统都可能。不碰页面，好单独测。
// 唯一的例外是同一个目录的另一种写法（macOS 上 /private/var 和 /var 是一处）：由调用的一方按设备的系统
// 给（核心的 pathTwin），这里不认识是哪几处。
import type { PathTwin } from '@litch/core'

export interface CwdMark {
  /** sub：在工作区某个根的下面；away：不在这个工作区的任何一个根里 */
  kind: 'sub' | 'away'
  /** 相对那个根的路径，用 / 连。away 是 null */
  rel: string | null
}

/** 写法理齐了再比：分隔符都当成 /，连着的算一个，末尾的不要（整个就是一个 / 的除外） */
const tidy = (path: string): string => {
  const slashed = path.replace(/[\\/]+/g, '/')
  return slashed.length > 1 ? slashed.replace(/\/$/, '') : slashed
}

/**
 * 工作目录正好是工作区的某个根：没什么可说的，给 null。
 * 在某个根的下面：是子目录，给出相对路径（同时在几个根下面，取贴得最近的那个）。
 * 哪个根下面都不在：比如从别处挪进这个工作区的会话。
 * 没有归属的会话没有根可比，也给 null。
 * twin 是工作目录的另一种写法，两种写法哪一种对得上都算
 */
export function cwdMark(
  cwd: string,
  roots: readonly string[] | undefined,
  twin: PathTwin = () => null,
): CwdMark | null {
  const known = (roots ?? []).filter(Boolean).map(tidy)
  if (!cwd || known.length === 0) return null
  const path = tidy(cwd)
  const other = twin(path)
  let nearest: string | null = null
  for (const root of known) {
    if (path === root || other === root) return null
    const prefix = root.endsWith('/') ? root : `${root}/`
    const hit = path.startsWith(prefix) ? path : other?.startsWith(prefix) ? other : null
    if (hit === null) continue
    const rel = hit.slice(prefix.length)
    if (nearest === null || rel.length < nearest.length) nearest = rel
  }
  return nearest === null ? { kind: 'away', rel: null } : { kind: 'sub', rel: nearest }
}
