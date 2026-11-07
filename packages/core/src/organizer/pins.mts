// 全局置顶：置顶资格只来自各台设备（置顶的会话、置顶的项目），这里把它们并成一个区，先后按本机记着的排。
// 设备之间的时钟不互相比较；没记过的按设备登记顺序、设备里的置顶次序接在最后。
import { type PinRef, pinKey } from './file.mjs'

/** 一台设备的置顶资格 */
export interface PinSource {
  deviceId: string
  /** 会话目录到了（连着、或者有上次的快照）。没到的设备，本机记着的位置原样留着，不显示也不清 */
  loaded: boolean
  /** 置顶的会话，按设备里的次序 */
  sessions: readonly string[]
  /** 置顶的项目，按设备上项目的次序 */
  workspaces: readonly string[]
}

export interface MergedPins {
  /** 置顶区里现在要画的，按先后 */
  shown: PinRef[]
  /** 写回本机文件的先后：shown 加上目录还没到的设备上记着的那些（位置不变） */
  stored: PinRef[]
}

/**
 * 合并。sources 是所有登记着的设备，按登记顺序；不在里面的设备（连接删掉了）记着的位置丢掉
 */
export function mergePins(saved: readonly PinRef[], sources: readonly PinSource[]): MergedPins {
  const byDevice = new Map(sources.map((source) => [source.deviceId, source]))
  const current = new Map<string, PinRef>()
  for (const source of sources) {
    if (!source.loaded) continue
    for (const sessionId of source.sessions) {
      const ref: PinRef = { kind: 'session', deviceId: source.deviceId, sessionId }
      current.set(pinKey(ref), ref)
    }
    for (const workspaceId of source.workspaces) {
      const ref: PinRef = { kind: 'workspace', deviceId: source.deviceId, workspaceId }
      current.set(pinKey(ref), ref)
    }
  }
  const stored: PinRef[] = []
  const placed = new Set<string>()
  for (const ref of saved) {
    const source = byDevice.get(ref.deviceId)
    const key = pinKey(ref)
    if (!source || placed.has(key)) continue
    if (source.loaded && !current.has(key)) continue
    placed.add(key)
    stored.push(ref)
  }
  for (const [key, ref] of current) {
    if (placed.has(key)) continue
    placed.add(key)
    stored.push(ref)
  }
  const shown = stored.filter((ref) => current.has(pinKey(ref)))
  return { shown, stored }
}

/**
 * 把 ref 挪到置顶区里第 to 个（按挪走之后的位置数），返回新的 stored。
 * 目录没到的设备的那些占着原来的格子不动；挪了等于没挪是 null
 */
export function movePin(merged: MergedPins, ref: PinRef, to: number): PinRef[] | null {
  const key = pinKey(ref)
  const from = merged.shown.findIndex((entry) => pinKey(entry) === key)
  if (from < 0) return null
  const rest = merged.shown.filter((_, index) => index !== from)
  const at = Math.min(Math.max(0, Math.trunc(to)), rest.length)
  const order = [...rest.slice(0, at), merged.shown[from] as PinRef, ...rest.slice(at)]
  if (order.every((entry, index) => entry === merged.shown[index])) return null
  const shownKeys = new Set(merged.shown.map(pinKey))
  let next = 0
  return merged.stored.map((entry) =>
    shownKeys.has(pinKey(entry)) ? (order[next++] as PinRef) : entry,
  )
}
