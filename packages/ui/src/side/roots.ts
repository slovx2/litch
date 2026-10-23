// 会话的文件根：侧面板（文件、终端、差异）和对话里的文件链接都按它认，两边得一致，
// 不然链接点开的文件不在面板的树里。只有判断，好单独测。
import type { SessionSummary } from '@litch/core'

/**
 * 在设备层工作树里（目录没删）的会话，根是那棵工作树（不看源仓库）；属于工作区的，是工作区的根；
 * 都不是的，是它的工作目录。什么都没有是空的
 */
export function sessionRoots(
  summary: Pick<SessionSummary, 'worktree' | 'cwd'> | undefined,
  workspaceRoots: string[] | undefined,
): string[] {
  const tree = summary?.worktree
  if (tree && tree.state !== 'removed') return [tree.path]
  if (workspaceRoots) return workspaceRoots
  return summary?.cwd ? [summary.cwd] : []
}
