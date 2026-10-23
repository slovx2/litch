// 新建页“在哪做”（本地 / 新工作树）和“从哪切”：按“设备 + 工作区”记上次选的，和 remembered.ts 的 harness 一样存在本地存储里。
// 工作区根是不是 git 仓库、有哪些分支，问设备（useBranches.ts）；不是仓库、设备不能建工作树时这一项不出。
// 这里只有判断，不碰页面，好单独测。
import type { WorktreeBranchesView, WorktreeFrom } from '@litch/core'

const WHERE_KEY = 'litch.lastWorktree'

/** “从哪切”选项的标识：默认分支、当前本地状态，或者 branch: 加分支名 */
export type FromId = string
export const FROM_DEFAULT = 'default'
export const FROM_WORKING = 'working-tree'
const BRANCH = 'branch:'

export interface WhereChoice {
  /** 在新工作树里建 */
  worktree: boolean
  from: FromId
}

const LOCAL: WhereChoice = { worktree: false, from: FROM_DEFAULT }

const spot = (deviceId: string, workspaceId: string) => `${deviceId}/${workspaceId}`

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(WHERE_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 上次在这个工作区里选的；没记过是本地、默认分支 */
export function recallWhere(deviceId: string, workspaceId: string | null): WhereChoice {
  if (!workspaceId) return LOCAL
  const raw = readAll()[spot(deviceId, workspaceId)]
  if (typeof raw !== 'object' || raw === null) return LOCAL
  const { worktree, from } = raw as Record<string, unknown>
  return { worktree: worktree === true, from: typeof from === 'string' ? from : FROM_DEFAULT }
}

/** 会话建成了：记下这次在这个工作区里选的 */
export function rememberWhere(
  deviceId: string,
  workspaceId: string | null,
  choice: WhereChoice,
): void {
  if (!workspaceId) return
  try {
    localStorage.setItem(
      WHERE_KEY,
      JSON.stringify({ ...readAll(), [spot(deviceId, workspaceId)]: choice }),
    )
  } catch {
    // 存不进去不影响这次使用
  }
}

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
