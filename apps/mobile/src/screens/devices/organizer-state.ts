// 首页的全局置顶和本机分组在手机上取数据、发整理命令的几样小东西。合并规则在核心（organizer/），
// 和桌面同一份；这里只把副本里的键接上。本机分组只存在这台手机上（shell/organizer-file.ts），不同步。
import {
  type CoreChannel,
  keys,
  type LocalGroup,
  localLayout,
  type MemberRef,
  type MergedPins,
  mergePins,
  type OrganizerAction,
  type OrganizerView,
  pinSourceOf,
  type SessionChildren,
  type SessionGroups,
  sameRef,
  type WorkspaceView,
} from '@litch/core'
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { useKey, useReplica } from '../../shell/services'

const NONE: string[] = []

/** 订阅一串键；哪个值都没换就还是同一个数组 */
export function useKeyList<T>(list: readonly string[]): (T | undefined)[] {
  const { store } = useReplica()
  const joined = list.join('\n')
  const cache = useRef<(T | undefined)[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 键按内容比较（joined）
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = list.map((key) => store.subscribe(key, listener))
      return () => {
        for (const stop of stops) stop()
      }
    },
    [store, joined],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上
  const get = useCallback(() => {
    const values = list.map((key) => store.get<T>(key))
    const was = cache.current
    if (was && was.length === values.length && was.every((value, i) => value === values[i]))
      return was
    cache.current = values
    return values
  }, [store, joined])
  return useSyncExternalStore(subscribe, get)
}

export const useOrganizer = (): OrganizerView | undefined => useKey<OrganizerView>(keys.organizer)

/** 文件坏了或者是更新版本的应用写的：只读，不许改（核心也会拒绝） */
export const organizerBlocked = (organizer: OrganizerView | undefined): boolean =>
  organizer !== undefined && organizer.status !== 'ok'

/** 发一个本机整理动作，交给页面的 act 去报错 */
export const organize = (
  channel: CoreChannel,
  action: OrganizerAction,
): Promise<{ revision: number; groupId?: string }> => channel.command('organizer.apply', { action })

/** 这个会话在哪个本机组里（最多一个） */
export const groupOfMember = (
  organizer: OrganizerView | undefined,
  ref: MemberRef,
): LocalGroup | undefined =>
  organizer?.groups.find((group) => group.members.some((member) => sameRef(member, ref)))

/** 所有设备的置顶并成一个区 */
export function useMergedPins(): MergedPins {
  const organizer = useOrganizer()
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const groups = useKeyList<SessionGroups>(devices.map(keys.groups))
  const workspaces = useKeyList<WorkspaceView[]>(devices.map(keys.workspaces))
  const saved = organizer?.pinOrder
  return useMemo(
    () =>
      mergePins(
        saved ?? [],
        devices.map((deviceId, index) => pinSourceOf(deviceId, groups[index], workspaces[index])),
      ),
    [saved, devices, groups, workspaces],
  )
}

/** 本机分组按实体去重，项目与显式会话跨组共用归属。 */
export function useLocalLayout() {
  const organizer = useOrganizer()
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const groups = useKeyList<SessionGroups>(devices.map(keys.groups))
  const children = useKeyList<SessionChildren>(devices.map(keys.children))
  const workspaces = useKeyList<WorkspaceView[]>(devices.map(keys.workspaces))
  const covers = useKeyList<string[]>(devices.map(keys.pinCover))
  return useMemo(
    () =>
      localLayout(
        organizer?.groups ?? [],
        devices.map((deviceId, index) => ({
          deviceId,
          groups: groups[index],
          children: children[index],
          // 手机没有全局置顶区，项目不能因此从本机组详情消失。
          workspaces: workspaces[index]?.map((workspace) => ({ ...workspace, pinned: false })),
          covered: covers[index],
        })),
      ),
    [organizer?.groups, devices, groups, children, workspaces, covers],
  )
}
