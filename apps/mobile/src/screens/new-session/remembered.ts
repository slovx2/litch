// 新建会话页记住的几样：上次在这台设备上建在哪个工作区、用哪个 harness，各 harness 上选过的模型、强度、权限，
// 各工作区上次选的“位置”（本地还是新工作树）和“起点”。
// 存在应用文档目录的 new-session.json。计划模式不记：它只管眼前这一个新会话（和桌面端 remembered.ts 一样）。
// 记下的东西过期了（工作区删了、harness 没了、模型换了）就当没记过，由默认值顶上。
import type { ComposeOptions, HarnessView, SessionSettings } from '@litch/core'
import { FROM_DEFAULT } from '../../../../../packages/ui/src/composer/worktree-from.ts'
import { jsonFile } from '../../shell/json-file'

type Picks = Partial<Omit<SessionSettings, 'mode'>>

interface Memory {
  /** 设备 → 上次的工作区（null 是不属于任何工作区） */
  place: Record<string, string | null>
  /** `设备` 或 `设备/工作区` → 上次用的 harness */
  harness: Record<string, string>
  /** `设备/harness` → 上次选的设置 */
  picks: Record<string, Picks>
  /** `设备/工作区` → 上次选的位置和起点（起点的标识同桌面 composer/worktree-from.ts） */
  where: Record<string, { worktree: boolean; from: string }>
}

const file = jsonFile<Memory>('new-session.json')
let memory: Memory | null = null

function read(): Memory {
  if (memory) return memory
  const stored = file.read()
  memory = {
    place: stored?.place ?? {},
    harness: stored?.harness ?? {},
    picks: stored?.picks ?? {},
    where: stored?.where ?? {},
  }
  return memory
}

const spot = (deviceId: string, workspaceId: string | null) => `${deviceId}/${workspaceId ?? ''}`

export const lastPlace = (deviceId: string): string | null | undefined => read().place[deviceId]

/** 建在哪个 harness 上：这次点选的、这个工作区上次用的、这台设备上最近用的，头一个现在可用的；都不行就是可用的里第一个 */
export function pickHarness(
  ready: readonly HarnessView[],
  deviceId: string,
  workspaceId: string | null,
  chosen: string | undefined,
): HarnessView | undefined {
  const last = read().harness
  for (const wish of [chosen, last[spot(deviceId, workspaceId)], last[deviceId]]) {
    const hit = wish === undefined ? undefined : ready.find((entry) => entry.id === wish)
    if (hit) return hit
  }
  return ready[0]
}

/** 上次的选择里现在还选得到的那几项 */
export function recallPicks(deviceId: string, harness: string, options: ComposeOptions): Picks {
  const last = read().picks[`${deviceId}/${harness}`] ?? {}
  const picks: Picks = {}
  const model = options.models.find((entry) => entry.id === last.model)
  if (model) picks.model = model.id
  if (last.effort && (!model || model.efforts.some((effort) => effort.id === last.effort)))
    picks.effort = last.effort
  if (last.permission && options.permissions.some((preset) => preset.id === last.permission))
    picks.permission = last.permission
  return picks
}

/** 建成了一个会话：记下这一次 */
export function remember(
  deviceId: string,
  workspaceId: string | null,
  harness: string | undefined,
  picks: Picks,
): void {
  const mine = read()
  mine.place[deviceId] = workspaceId
  if (harness) {
    mine.harness[spot(deviceId, workspaceId)] = harness
    mine.harness[deviceId] = harness
    mine.picks[`${deviceId}/${harness}`] = picks
  }
  try {
    file.write(mine)
  } catch {
    // 记不下不影响建会话
  }
}

/** 这个工作区上次选的位置和起点；没记过是本地、默认分支 */
export function recallWhere(
  deviceId: string,
  workspaceId: string | null,
): { worktree: boolean; from: string } {
  const last = workspaceId ? read().where[spot(deviceId, workspaceId)] : undefined
  return { worktree: last?.worktree === true, from: last?.from ?? FROM_DEFAULT }
}

/** 会话建成了：记下这次在这个工作区里选的位置和起点 */
export function rememberWhere(
  deviceId: string,
  workspaceId: string | null,
  choice: { worktree: boolean; from: string },
): void {
  if (!workspaceId) return
  const mine = read()
  mine.where[spot(deviceId, workspaceId)] = choice
  try {
    file.write(mine)
  } catch {
    // 记不下不影响建会话
  }
}
