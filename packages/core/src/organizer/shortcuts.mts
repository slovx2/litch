// 快捷区（全局置顶、本机分组）的投影：从各台设备的目录里认出置顶资格、算出哪些会话已经画在置顶区，
// 以及本机组里每个成员现在是什么情况。桌面侧栏和手机首页共用这一份，不各写一套合并规则。

import type { DeviceView, WorkspaceView } from '../model.mjs'
import type { SessionChildren, SessionGroups } from '../replica/replica.mjs'
import type { SessionRef } from './file.mjs'
import type { PinSource } from './pins.mjs'

/** 置顶会话那一组的键（和副本 SessionGroups 的一致） */
const PINNED_GROUP = ':pinned'
/** 子会话往下最多找几层（和侧栏画树的上限一致，防对面给错成环） */
const MAX_DEPTH = 8

/** 一台设备的置顶资格。groups 还没到（目录没来过）就是没加载 */
export function pinSourceOf(
  deviceId: string,
  groups: SessionGroups | undefined,
  workspaces: readonly WorkspaceView[] | undefined,
): PinSource {
  return {
    deviceId,
    loaded: groups !== undefined,
    sessions: groups?.[PINNED_GROUP] ?? [],
    workspaces: (workspaces ?? []).filter((entry) => entry.pinned).map((entry) => entry.id),
  }
}

/**
 * 画在置顶区里的会话：置顶的会话、置顶项目里（没进设备分组的）会话，以及它们下面的子会话。
 * 这些在设备目录、最近、未读、本机组里都不再画一遍（置顶只出现一次）
 */
export function pinCover(
  groups: SessionGroups,
  workspaces: readonly WorkspaceView[],
  children: SessionChildren,
): string[] {
  const cover = new Set<string>()
  const add = (id: string, depth: number) => {
    if (cover.has(id) || depth > MAX_DEPTH) return
    cover.add(id)
    for (const kid of children[id] ?? []) add(kid, depth + 1)
  }
  for (const id of groups[PINNED_GROUP] ?? []) add(id, 0)
  for (const workspace of workspaces) {
    if (!workspace.pinned) continue
    for (const id of groups[workspace.id] ?? []) add(id, 0)
  }
  return [...cover].sort()
}

/**
 * 本机组里一个成员现在的情况：
 * ok 能画；pinned 在置顶区（这里不画，组里数一下）；unconfigured 设备连接删掉了；
 * unloaded 设备的目录没到、还没对过账；archived 归档了；deleted 设备对过账、归档列表里也没有；
 * missing 设备对过账了、目录里没有，但归档列表还没取过（分不清归档还是删除）
 */
export type MemberState =
  | 'ok'
  | 'pinned'
  | 'unconfigured'
  | 'unloaded'
  | 'archived'
  | 'deleted'
  | 'missing'

/** 认成员情况要知道的：都从副本里取 */
export interface MemberFacts {
  device: DeviceView | undefined
  /** 目录里有这个会话（有摘要） */
  listed: boolean
  /** 在置顶区里 */
  covered: boolean
  /** 归档列表：null 是还没取过 */
  archived: readonly string[] | null
}

/** 设备的目录和对面对过账了：连着、不是上次留下的、没有“目录没取到”的说明 */
export const catalogSettled = (device: DeviceView | undefined): boolean =>
  device?.connection === 'online' && !device.stale && device.note === null

export function memberState(ref: SessionRef, facts: MemberFacts): MemberState {
  if (!facts.device) return 'unconfigured'
  if (facts.covered) return 'pinned'
  if (facts.listed) return 'ok'
  if (facts.archived?.includes(ref.sessionId)) return 'archived'
  if (!catalogSettled(facts.device)) return 'unloaded'
  return facts.archived ? 'deleted' : 'missing'
}
