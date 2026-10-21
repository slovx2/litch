// 上次新建会话时选的：在哪台设备、这台设备上的哪个工作区、这个工作区里建在哪个 harness 上，
// 和在那个 harness 上选的模型、强度、权限预设。下次新建时默认还是这几个。
// 存在浏览器的本地存储里，读写失败就当没记过。
import type { ComposeOptions, DeviceView, HarnessView, SessionSettings } from '@litch/core'
import { useSyncExternalStore } from 'react'
import { defaultHarness, fitPicks } from './new-place.ts'

const STORE_KEY = 'litch.lastSettings'
/**
 * 上次建会话用的 harness，两种键记在一起：“设备/工作区”是这个工作区上次用的（不属于任何工作区的那些，工作区一段是空的），
 * 单独一个设备标识是这台设备上最近一次用的（还没在上面建过会话的工作区拿它当默认）
 */
const HARNESS_KEY = 'litch.lastHarness'
/** 上次在新建对话页建会话用的那台设备。只有 id 这一项 */
const DEVICE_KEY = 'litch.lastDevice'
/** 设备标识 → 上次在它上面建会话时选的工作区。null 是“不属于任何工作区” */
const WORKSPACE_KEY = 'litch.lastWorkspace'

type Picks = Partial<SessionSettings>

function read<T>(storeKey: string): Record<string, T> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storeKey) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, T>) : {}
  } catch {
    return {}
  }
}

function write<T>(storeKey: string, key: string, value: T): void {
  try {
    localStorage.setItem(storeKey, JSON.stringify({ ...read<T>(storeKey), [key]: value }))
  } catch {
    // 存不进去不影响这次使用
  }
}

/** 模型这些是 harness 自己的东西：一台设备上每个 harness 各记各的 */
const slot = (deviceId: string, harness: string) => `${deviceId}/${harness}`

export function rememberPicks(deviceId: string, harness: string, picks: Picks): void {
  write(STORE_KEY, slot(deviceId, harness), picks)
}

/** 会话建成了：记下这次建在哪台设备、哪个工作区。下次打开新建对话页默认还是这里 */
export function rememberPlace(deviceId: string, workspaceId: string | null): void {
  write(DEVICE_KEY, 'id', deviceId)
  write(WORKSPACE_KEY, deviceId, workspaceId)
}

/** 上次在新建对话页建会话用的那台设备。没记过是 undefined */
export function recallDevice(): string | undefined {
  const id = read<unknown>(DEVICE_KEY).id
  return typeof id === 'string' ? id : undefined
}

/** 上次在这台设备上建会话时选的工作区：null 是“不属于任何工作区”，没记过是 undefined */
export function recallWorkspace(deviceId: string): string | null | undefined {
  const all = read<unknown>(WORKSPACE_KEY)
  if (!Object.hasOwn(all, deviceId)) return undefined
  const last = all[deviceId]
  return typeof last === 'string' || last === null ? last : undefined
}

/** harness 是按“设备上的哪个工作区”记的：同一台设备上不同的工作区各用各的 */
const spot = (deviceId: string, workspaceId: string | null) => `${deviceId}/${workspaceId ?? ''}`

/**
 * 这次在新建对话页上点选的那个 harness。不跟着去处记：换了设备、换了项目还是它（那边没有的话才按默认的来），
 * 还没发出去就切走再回来也还在。建成了会话就放下，之后各个项目回到各自记下的
 */
let picked: string | undefined
const watchers = new Set<() => void>()
const watch = (watcher: () => void) => {
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
  }
}
const repick = (harness: string | undefined) => {
  picked = harness
  for (const watcher of watchers) watcher()
}

/** 选一个 harness：新建会话的那一页和标题栏都跟着变 */
export function pickHarness(harness: string): void {
  repick(harness)
}

/**
 * 会话建成了：记下这个工作区这次用的是哪个 harness（下次在这里默认还是它），同时也是这台设备上最近用的。
 * 页上点选的那个到这里就放下了
 */
export function rememberHarness(
  deviceId: string,
  workspaceId: string | null,
  harness: string,
): void {
  write(HARNESS_KEY, spot(deviceId, workspaceId), harness)
  write(HARNESS_KEY, deviceId, harness)
  repick(undefined)
}

/**
 * 新建会话建在哪个 harness 上：这次在页上点选的，没点过就是这个工作区上次用的，这个工作区还没用过就是
 * 这台设备上最近用的，再没有就是第一个可用的。前三个得现在可用才算数。一个可用的都没有就是 undefined。
 */
export function useNewHarness(
  device: DeviceView | undefined,
  workspaceId: string | null,
): HarnessView | undefined {
  const deviceId = device?.id ?? ''
  const here = spot(deviceId, workspaceId)
  const chosen = useSyncExternalStore(watch, () => picked)
  const ready = device?.harnesses.filter((entry) => entry.state === 'ready') ?? []
  const last = read<string>(HARNESS_KEY)
  return defaultHarness(ready, [chosen, last[here], last[deviceId]])
}

/** 上次的选择里现在还选得到的那几项。对面换过模型清单之后，过期的不带出来 */
export function recallPicks(deviceId: string, harness: string, options: ComposeOptions): Picks {
  return fitPicks(read<Picks>(STORE_KEY)[slot(deviceId, harness)] ?? {}, options)
}
