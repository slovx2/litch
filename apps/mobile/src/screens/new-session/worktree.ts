// 新建页的“位置”（本地 / 新工作树）和“起点”：问设备工作区根所在仓库的分支（worktree.branches），
// 不是 git 仓库、设备建不了工作树时这一项不出。起点的标识和换算用桌面 composer/worktree-from.ts 那一份，
// 记住上次选的在 remembered.ts，问分支在 useBranches.ts。这里只有判断，好单独测。
import type { WorktreeBranchesView, WorktreeFrom } from '@litch/core'
import {
  branchFrom,
  FROM_DEFAULT,
  FROM_WORKING,
  fromOf,
} from '../../../../../packages/ui/src/composer/worktree-from.ts'
import type { useT } from '../../ui/i18n'

export interface FromOption {
  id: string
  title: string
  note?: string
}

/** “起点”的选项：默认分支、当前本地状态，再是本地分支（当前分支注明）和远程分支 */
export function fromOptions(
  branches: WorktreeBranchesView,
  t: ReturnType<typeof useT>,
): FromOption[] {
  return [
    {
      id: FROM_DEFAULT,
      title: t('newSession.from.default', { branch: branches.defaultBranch ?? 'HEAD' }),
    },
    {
      id: FROM_WORKING,
      title: t('newSession.from.working'),
      note: t('newSession.from.workingHint'),
    },
    ...branches.local.map((name) => ({
      id: branchFrom(name),
      title: name,
      ...(name === branches.current ? { note: t('newSession.from.current') } : {}),
    })),
    ...branches.remote.map((name) => ({ id: branchFrom(name), title: name })),
  ]
}

/** session.create 的 worktree：默认分支不带起点，设备按默认分支切 */
export function worktreeParam(from: string): { from?: WorktreeFrom } {
  const picked = fromOf(from)
  return picked ? { from: picked } : {}
}
