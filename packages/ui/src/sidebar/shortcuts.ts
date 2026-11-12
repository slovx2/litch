// 快捷区（全局置顶、本地分组）在桌面侧栏里取数据、发整理命令的几样小东西。
// 合并规则在核心（organizer/pins.mts、shortcuts.mts），这里只把副本里的键接上。
import {
  type CoreChannel,
  keys,
  type LocalGroup,
  type MergedPins,
  mergePins,
  type OrganizerAction,
  type OrganizerView,
  pinSourceOf,
  type SessionGroups,
  type SessionRef,
  sameRef,
  type WorkspaceView,
} from '@litch/core'
import { useMemo } from 'react'
import { reasonOf } from '../app/errors.ts'
import { useKey, useKeys } from '../app/services.tsx'
import { showToast } from '../app/toasts.tsx'

const NONE: readonly string[] = []

export const useOrganizer = (): OrganizerView | undefined => useKey<OrganizerView>(keys.organizer)

/** 发一个本机整理动作；没做成出一条提示（行上没有地方说）。成功时回核心的结果 */
export function organize(
  channel: CoreChannel,
  action: OrganizerAction,
): Promise<{ revision: number; groupId?: string } | null> {
  return channel.command('organizer.apply', { action }).catch((error: unknown) => {
    showToast({
      id: 'organizer-failed',
      tone: 'err',
      lifeMs: 8000,
      text: (say) => say('session.failed', { reason: reasonOf(error, say) }),
    })
    return null
  })
}

/** 这个会话在哪个本地分组里（最多一个） */
export const groupOfMember = (
  organizer: OrganizerView | undefined,
  ref: SessionRef,
): LocalGroup | undefined =>
  organizer?.groups.find((group) => group.members.some((member) => sameRef(member, ref)))

/** 所有设备的置顶并成一个区。设备、目录、项目哪个变了才重算 */
export function useMergedPins(): MergedPins {
  const organizer = useOrganizer()
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const groups = useKeys<SessionGroups>(devices.map(keys.groups))
  const workspaces = useKeys<WorkspaceView[]>(devices.map(keys.workspaces))
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

/** 所有设备画在置顶区里的会话，按设备分 */
export function useCovers(): ReadonlyMap<string, ReadonlySet<string>> {
  const devices = useKey<string[]>(keys.devices) ?? NONE
  const covers = useKeys<string[]>(devices.map(keys.pinCover))
  return useMemo(
    () => new Map(devices.map((deviceId, index) => [deviceId, new Set(covers[index] ?? NONE)])),
    [devices, covers],
  )
}
