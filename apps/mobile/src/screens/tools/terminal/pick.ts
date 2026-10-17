// 终端页里不靠画面就能算的几件事：叫什么、该看哪一个、关掉一个之后换到哪一个、根目录归哪个工作区。
import { LOOSE, type TerminalGroups, type TerminalInfo, type WorkspaceView } from '@litch/core'
import type { Translator } from '../../../ui/i18n'

export const terminalName = (info: TerminalInfo | undefined, t: Translator): string =>
  info?.title ?? t('terminal.defaultName', { n: info?.seq ?? 1 })

export const stateWord = (info: TerminalInfo, t: Translator): string =>
  t(`tools.term.state.${info.state}`)

/** 根目录是哪个工作区的（工作区的哪个根对得上都算）。都对不上是 null：设备主目录的那一组 */
export function workspaceOf(
  workspaces: readonly WorkspaceView[] | undefined,
  root: string | null,
): string | null {
  if (!root || !workspaces) return null
  const trimmed = root.replace(/\/+$/, '')
  return (
    workspaces.find((workspace) =>
      workspace.roots.some((one) => one.replace(/\/+$/, '') === trimmed),
    )?.id ?? null
  )
}

/** 一组里开成标签的终端（按标签的顺序） */
export const groupIds = (
  groups: TerminalGroups | undefined,
  workspaceId: string | null,
): string[] => groups?.[workspaceId ?? LOOSE] ?? []

const alive = (info: TerminalInfo | undefined): info is TerminalInfo =>
  !!info && (info.state === 'running' || info.state === 'starting' || info.state === 'away')

/**
 * 没指定看哪个终端时（从详情页的菜单进来）：这一组里开在同一个目录、还活着的，挑最后开的那个；
 * 没有就是 null，由页面新开一个。不挑别的目录的终端：人是要在这个目录里干活
 */
export function pickExisting(
  ids: readonly string[],
  infoOf: (id: string) => TerminalInfo | undefined,
  root: string | null,
): string | null {
  for (let at = ids.length - 1; at >= 0; at--) {
    const id = ids[at] as string
    const info = infoOf(id)
    if (alive(info) && (root === null || info.cwd === root)) return id
  }
  return null
}

/** 关掉一个之后看哪一个：同一组里它后面的，没有就前面的；一组都没了是 null（页面退回去） */
export function nextAfterClose(ids: readonly string[], closed: string): string | null {
  const at = ids.indexOf(closed)
  const rest = ids.filter((id) => id !== closed)
  if (rest.length === 0) return null
  return rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null
}
