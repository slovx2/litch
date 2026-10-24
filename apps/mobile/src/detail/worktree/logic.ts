// 详情页“工作树”一页的几句话：起点怎么念、能不能合入基础分支、合完怎么说。
// 起点的说法用桌面 worktrees/labels.ts 那一份。
import type { SessionWorktreeView, WorktreeSyncView } from '@litch/core'
import { baseName } from '../../../../../packages/ui/src/worktrees/labels.ts'
import type { useT } from '../../ui/i18n'

type T = ReturnType<typeof useT>

export const baseOf = (worktree: SessionWorktreeView, t: T): string => baseName(worktree.baseRef, t)

/** 从 HEAD、当前本地状态切的没有基础分支，合入那一项不出；目录删了的也不出 */
export const canSync = (worktree: SessionWorktreeView): boolean =>
  worktree.state !== 'removed' &&
  worktree.baseRef !== 'HEAD' &&
  worktree.baseRef !== '' &&
  worktree.baseRef !== 'working-tree'

/** 合入基础分支之后的一句 */
export function syncNote(result: WorktreeSyncView, base: string, t: T): string {
  if (result.status === 'conflicts')
    return t('worktree.sync.conflicts', { files: result.files.join('、') })
  return t(result.status === 'merged' ? 'worktree.sync.merged' : 'worktree.sync.upToDate', { base })
}
