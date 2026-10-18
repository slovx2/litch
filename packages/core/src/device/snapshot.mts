// 一台设备上次留下的侧栏：存什么、读回来的东西怎么检查。存在哪由外壳定。
import type { Thread } from '../../../protocol/src/index.mjs'
import type { DeviceView, HarnessView, WorkspaceView } from '../model.mjs'

/**
 * 一台设备上次留下的侧栏：对面是哪种、有哪些 harness、有哪些工作区、有哪些会话（只有元数据，不带回合）。
 * 设备还没连上或者连不上时，拿它只读地显示；连上之后以对面为准整体换掉。
 * 完整模式下会话对象上带着它属于哪个 harness（聚合面打的 `harness`），原样存着。
 */
export interface DeviceSnapshot {
  mode: DeviceView['mode']
  harnesses: HarnessView[]
  workspaces: WorkspaceView[]
  threads: Thread[]
  /**
   * 标着未读的会话。未读是这台电脑自己记的（对面没有这回事），跟着侧栏一起存，重启之后还在。
   * 只记 threads 里有的：会话没了（删了、归档了、对账时设备上已经没有）就不留，所以不会比会话还多
   */
  unread: string[]
}

/** 快照存在哪由外壳定。存取失败不影响使用 */
export interface SnapshotStore {
  load(): DeviceSnapshot | null
  save(snapshot: DeviceSnapshot): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 检查读回来的快照。形状对不上的（包括以前的版本存的）当作没存过，不去猜 */
export function checkSnapshot(value: unknown): DeviceSnapshot | null {
  if (!isRecord(value)) return null
  const { mode, harnesses, workspaces, threads, unread } = value
  if (mode !== 'full' && mode !== 'single') return null
  if (!Array.isArray(harnesses) || !Array.isArray(workspaces) || !Array.isArray(threads)) {
    return null
  }
  const named = (entry: unknown): boolean => isRecord(entry) && typeof entry.id === 'string'
  if (!harnesses.every(named) || !workspaces.every(named)) return null
  return {
    mode,
    harnesses: harnesses as HarnessView[],
    workspaces: workspaces as WorkspaceView[],
    threads: threads.filter(named) as Thread[],
    // 上一版存的快照里没有这一项：当作没有未读的，不为它把整份侧栏丢掉
    unread: Array.isArray(unread)
      ? unread.filter((id): id is string => typeof id === 'string')
      : [],
  }
}
