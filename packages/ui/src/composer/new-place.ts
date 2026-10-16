// 新建对话页默认建在哪：哪台设备、哪个工作区。这里只有判断，不碰存储也不碰界面，单独拿出来好测
// （packages/ui/test/new-place.test.mjs）。记住上次用的是哪里，在 remembered.ts。
import type { DeviceView, WorkspaceView } from '@litch/core'

/** 要建在哪。workspaceId 为 null 表示不属于任何工作区 */
export interface Place {
  deviceId: string
  workspaceId: string | null
}

/**
 * 在新建对话页上明说的去处：从侧栏工作区行的加号带过来的，或者在页上自己换的。
 * 只说了设备、没说工作区（workspaceId 不给）的，工作区按这台设备的默认来
 */
export interface PlaceWish {
  deviceId: string
  workspaceId?: string | null
}

/** 定默认去处要看的几样 */
export interface PlaceFacts {
  /** 现在有的设备，按添加的顺序 */
  devices: readonly Pick<DeviceView, 'id' | 'kind' | 'connection'>[]
  /** 这台设备上的工作区。还没到就是 undefined */
  workspaces(deviceId: string): readonly Pick<WorkspaceView, 'id'>[] | undefined
  /** 上次在这一页建会话用的那台设备。没记过是 undefined */
  lastDevice: string | undefined
  /** 上次在这台设备上建会话时选的工作区：null 是“不属于任何工作区”，没记过是 undefined */
  lastWorkspace(deviceId: string): string | null | undefined
}

/**
 * 默认的设备：上次在这一页建会话用的那台（还在的话），没有就是本机那台，再没有就是第一台连着的，
 * 都没有就是排最前面的那台（没连上也给出来：那一页会说它为什么用不了）。一台设备都没有是 null。
 * 不因为“上次那台现在没连上”就换一台：刚启动时每台都还在连，换来换去的话人正写着字，去处就变了
 */
export function defaultDevice(facts: PlaceFacts): string | null {
  const { devices, lastDevice } = facts
  if (lastDevice !== undefined && devices.some((device) => device.id === lastDevice)) {
    return lastDevice
  }
  const pick =
    devices.find((device) => device.kind === 'local') ??
    devices.find((device) => device.connection === 'online') ??
    devices[0]
  return pick?.id ?? null
}

/** 默认的工作区：上次在这台设备上用的那个（还在的话），没有就是不属于任何工作区 */
export function defaultWorkspace(deviceId: string, facts: PlaceFacts): string | null {
  const last = facts.lastWorkspace(deviceId)
  if (typeof last !== 'string') return null
  return facts.workspaces(deviceId)?.some((workspace) => workspace.id === last) ? last : null
}

/**
 * 新建会话默认建在哪个 harness 上：按给的先后挨个看（这次在这里点选的、这个工作区上次用的、这台设备上最近用的），
 * 头一个现在可用的就是它；都不行就是可用的里排第一的。一个可用的都没有是 undefined
 */
export function defaultHarness<H extends { id: string }>(
  ready: readonly H[],
  wishes: readonly (string | undefined)[],
): H | undefined {
  for (const wish of wishes) {
    const hit = wish === undefined ? undefined : ready.find((entry) => entry.id === wish)
    if (hit) return hit
  }
  return ready[0]
}

/**
 * 新建对话页现在指着哪。明说了的照它来，没说的按默认的来；一台设备都没有是 null。
 * 明说的那台设备已经不在了（被移除了），整个按默认的来。明说的工作区不在表里时不换成别的：
 * 由那一页说明它不在了，不悄悄建成不属于工作区的会话
 */
export function resolvePlace(wish: PlaceWish | null, facts: PlaceFacts): Place | null {
  const wished = wish && facts.devices.some((device) => device.id === wish.deviceId) ? wish : null
  const deviceId = wished?.deviceId ?? defaultDevice(facts)
  if (deviceId === null) return null
  const workspaceId =
    wished && wished.workspaceId !== undefined
      ? wished.workspaceId
      : defaultWorkspace(deviceId, facts)
  return { deviceId, workspaceId }
}
