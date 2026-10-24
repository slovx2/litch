// 新建页“在哪做”（本地 / 新工作树）和“从哪切”：按“设备 + 工作区”记上次选的，和 remembered.ts 的 harness 一样存在本地存储里。
// 工作区根是不是 git 仓库、有哪些分支，问设备（useBranches.ts）；不是仓库、设备不能建工作树时这一项不出。
// 这里只有判断，不碰页面，好单独测。起点的标识和换算在 worktree-from.ts（手机端也用，不碰本地存储）。
import { FROM_DEFAULT, type FromId } from './worktree-from.ts'

const WHERE_KEY = 'litch.lastWorktree'

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
