// 设置条上几样东西怎么叫：强度档、内置的三档权限。键是对面报的标识，文案用桌面界面现成的那几句。
// 不认识的照对面给的标识显示（和桌面端 packages/ui/src/composer/efforts.ts、SettingsBar.tsx 同一套规矩）。
import type { PermissionPreset } from '@litch/core'
import type { Key, Translator } from '../../ui/i18n'

const EFFORT_TEXT: Record<string, Key> = {
  none: 'effort.none',
  // Pi 的“不思考”
  off: 'effort.none',
  minimal: 'effort.minimal',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
  ultra: 'effort.ultra',
  persistent: 'effort.persistent',
}

export const effortTitle = (t: Translator, id: string): string => {
  const key = EFFORT_TEXT[id]
  return key ? t(key) : id
}

const PERMISSION_TEXT: Record<string, { title: Key; note: Key }> = {
  ':read-only': { title: 'permission.readOnly', note: 'permission.readOnly.note' },
  ':workspace': { title: 'permission.workspace', note: 'permission.workspace.note' },
  ':danger-full-access': { title: 'permission.fullAccess', note: 'permission.fullAccess.note' },
}

/** harness 自己声明的预设用它给的标题和说明（两种语言）；没有声明时是内置的三档，按标识去说 */
export function permissionText(
  t: Translator,
  preset: PermissionPreset,
): { title: string; note: string | null } {
  const known = PERMISSION_TEXT[preset.id]
  const title = preset.title ? t.said(preset.title) : known ? t(known.title) : preset.id
  const note = preset.note ? t.said(preset.note) : known ? t(known.note) : null
  return { title, note }
}
