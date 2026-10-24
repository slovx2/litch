// 新建页“从哪切”的起点：选项标识（默认分支、当前本地状态、branch: 加分支名）和发给设备的起点之间的换算。
// 只有判断，不碰本地存储和页面：桌面 worktree-place.ts 和手机新建页都用这一份。
import type { WorktreeBranchesView, WorktreeFrom } from '@litch/core'

/** “从哪切”选项的标识：默认分支、当前本地状态，或者 branch: 加分支名 */
export type FromId = string
export const FROM_DEFAULT = 'default'
export const FROM_WORKING = 'working-tree'
const BRANCH = 'branch:'

export const branchFrom = (name: string): FromId => `${BRANCH}${name}`

/** 选项标识换成发给设备的起点。默认分支不带（设备按默认分支切） */
export function fromOf(id: FromId): WorktreeFrom | undefined {
  if (id === FROM_WORKING) return { kind: 'working-tree' }
  if (id.startsWith(BRANCH)) return { kind: 'branch', branch: id.slice(BRANCH.length) }
  return undefined
}

/** 记下的起点在现在的分支里还在不在：分支被删了的退回默认分支 */
export function fitFrom(id: FromId, branches: WorktreeBranchesView | null | undefined): FromId {
  if (!id.startsWith(BRANCH)) return id === FROM_WORKING ? id : FROM_DEFAULT
  const name = id.slice(BRANCH.length)
  return branches && (branches.local.includes(name) || branches.remote.includes(name))
    ? id
    : FROM_DEFAULT
}
