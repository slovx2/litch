// 会话列表里收起了什么，按设备记：收起的组（closed：设备那一行是 ''，其余的键和 SessionGroups 的一样），
// 和收起了子会话的父会话（folded）。没记着的都是展开的，新出现的父会话、组也就照旧展开。
// 只管数，不碰存储：桌面侧栏记在 litch.sidebar（state.ts），手机记在自己的文件里（apps/mobile 的 sessions/folds.ts）。
// 会话删了、归档了，工作区、组删了，对应的记录在设备的会话目录对过账之后清掉（pruneFolds），免得越记越多。
import type { DeviceView, SessionGroups } from '@litch/core'

export interface DeviceFolds {
  closed: readonly string[]
  folded: readonly string[]
}

/** 设备标识 → 这台设备上收起了的。什么都没收起的设备不在里面 */
export type Folds = Readonly<Record<string, DeviceFolds>>

export type FoldKind = keyof DeviceFolds

export const NO_FOLDS: Folds = {}
export const NO_DEVICE_FOLDS: DeviceFolds = { closed: [], folded: [] }

const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string'))]
    : []

/** 存着的那份读回来：形状不对的丢掉 */
export function readFolds(raw: unknown): Folds {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_FOLDS
  const folds: Record<string, DeviceFolds> = {}
  for (const [deviceId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object') continue
    const { closed, folded } = entry as Partial<Record<FoldKind, unknown>>
    const next = { closed: ids(closed), folded: ids(folded) }
    if (next.closed.length > 0 || next.folded.length > 0) folds[deviceId] = next
  }
  return folds
}

const withDevice = (folds: Folds, deviceId: string, next: DeviceFolds): Folds => {
  const rest = { ...folds }
  delete rest[deviceId]
  return next.closed.length === 0 && next.folded.length === 0 ? rest : { ...rest, [deviceId]: next }
}

/** 收起的展开，展开的收起 */
export function toggleFold(folds: Folds, deviceId: string, kind: FoldKind, id: string): Folds {
  const entry = folds[deviceId] ?? NO_DEVICE_FOLDS
  const list = entry[kind]
  const next = list.includes(id) ? list.filter((other) => other !== id) : [...list, id]
  return withDevice(folds, deviceId, { ...entry, [kind]: next })
}

/** 只留还在的。什么都没去掉时原样返回（调用方据此决定要不要存） */
export function pruneFolds(
  folds: Folds,
  deviceId: string,
  keep: Readonly<Record<FoldKind, ReadonlySet<string>>>,
): Folds {
  const entry = folds[deviceId]
  if (!entry) return folds
  const closed = entry.closed.filter((id) => keep.closed.has(id))
  const folded = entry.folded.filter((id) => keep.folded.has(id))
  if (closed.length === entry.closed.length && folded.length === entry.folded.length) return folds
  return withDevice(folds, deviceId, { closed, folded })
}

/**
 * 能拿会话目录来清记录了没有：连着、目录和对面对过账、也没有哪个 harness 的会话没取到。
 * 上次留下的那份、取了一半的那份都不算，拿它们去清会把还在的会话的记录清掉
 */
export const foldsSettled = (device: DeviceView | undefined): boolean =>
  device?.connection === 'online' && !device.stale && device.note === null

/** 还在的有哪些：组是调用方给的那些键（固定的几个，加上各个工作区、各个组），父会话是目录里的会话（已归档的不在 groups 里） */
export const foldsKeep = (
  groups: SessionGroups,
  closed: Iterable<string>,
): Record<FoldKind, Set<string>> => ({
  closed: new Set(closed),
  folded: new Set(Object.values(groups).flat()),
})
