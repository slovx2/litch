// 路径选择器只列目标设备的目录，不读文件内容；桌面与手机共用这条读取流程。

import type { PathPickerEntry, PathPickerListing } from '../../protocol/src/path-picker.mjs'
import type { CoreChannel } from './channel/client.mjs'
import type { AbortSignalLike } from './channel/protocol.mjs'

export type { PathPickerEntry, PathPickerListing } from '../../protocol/src/path-picker.mjs'

import { normalizePath, parentPath } from './text/paths.mjs'

export type PathPickerKind = 'directory' | 'file'

export function pathPickerStart(value: string, kind: PathPickerKind): string | null {
  const path = value.trim()
  if (!path) return null
  return kind === 'file' ? parentPath(normalizePath(path)) : path
}
export function pathPickerChild(path: string, name: string): string {
  return normalizePath(`${path}/${name}`)
}
export async function readPathPicker(
  channel: Pick<CoreChannel, 'command'>,
  deviceId: string,
  kind: PathPickerKind,
  target: string | null,
  signal?: AbortSignalLike,
): Promise<PathPickerListing> {
  const listing = await channel.command(
    'paths.list',
    { deviceId, path: target },
    signal ? { signal } : undefined,
  )
  return {
    ...listing,
    entries: listing.entries.filter(
      (entry) =>
        pathPickerDirectory(entry) ||
        (kind === 'file' && (entry.kind === 'file' || entry.targetKind === 'file')),
    ),
  }
}

export const pathPickerDirectory = (entry: PathPickerEntry): boolean =>
  entry.kind === 'dir' || entry.targetKind === 'dir'
