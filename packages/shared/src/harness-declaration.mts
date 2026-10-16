// 各引擎共用的两件事：读握手里客户端声明的扩展，和内置三档权限预设的标识与标题。
// 形状定义在 packages/protocol/src/harness-capabilities.mts，规矩见设计文档 03 第十五节：
// 服务端主动给出的扩展内容只发给握手时声明过的连接，按声明区分，不按客户端的名字猜。
import { EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import {
  type CapabilityText,
  DECLINE_NOTE_MAX_LENGTH,
  DECLINE_WITH_NOTE_DECISION,
  type PermissionPreset,
} from '../../protocol/src/harness-capabilities.mjs'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * 握手参数（`initialize` 的 params）里客户端声明认识的扩展名。
 * 没带、带的不是字符串数组，都当作一个也没声明：这条连接上只发标准协议的内容。
 */
export function declaredExtensions(initializeParams: unknown): Set<string> {
  const listed = record(record(initializeParams).capabilities)[EXTENSIONS_CAPABILITY]
  if (!Array.isArray(listed)) return new Set()
  return new Set(listed.filter((name): name is string => typeof name === 'string'))
}

/**
 * 审批应答是不是“拒绝并附说明”（`{decision: {declineWithNote: {note}}}`）。
 * 是的话返回说明：去掉首尾空白，超过上限的部分截掉；空串表示用户没写，和普通的拒绝一样。
 * 不是这种决定返回 null。
 */
export function declineNote(response: unknown): string | null {
  const decision = record(response).decision
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return null
  const entries = Object.entries(decision)
  if (entries.length !== 1 || entries[0]?.[0] !== DECLINE_WITH_NOTE_DECISION) return null
  const note = record(entries[0][1]).note
  return typeof note === 'string' ? note.trim().slice(0, DECLINE_NOTE_MAX_LENGTH) : ''
}

/** 内置三档权限预设的标识：就是协议里 `permissionProfile/list` 给的那三个 */
export const PRESET = {
  readOnly: ':read-only',
  workspace: ':workspace',
  fullAccess: ':danger-full-access',
} as const

const TITLE: Record<string, CapabilityText> = {
  [PRESET.readOnly]: { 'zh-CN': '只读', en: 'Read only' },
  [PRESET.workspace]: { 'zh-CN': '项目内', en: 'In project' },
  [PRESET.fullAccess]: { 'zh-CN': '完全访问', en: 'Full access' },
}

const RISK: Record<string, PermissionPreset['risk']> = {
  [PRESET.readOnly]: 'low',
  [PRESET.workspace]: 'medium',
  [PRESET.fullAccess]: 'high',
}

/**
 * 拼一个内置档的预设：标题和风险等级三家一样，说明和能不能切换各引擎自己给（行为不一样）。
 * 完全访问以外的档不用二次确认。
 */
export function builtinPreset(
  id: (typeof PRESET)[keyof typeof PRESET],
  description: CapabilityText,
  switching: Pick<PermissionPreset, 'switchInSession' | 'switchDuringTurn'>,
): PermissionPreset {
  return {
    id,
    title: TITLE[id] as CapabilityText,
    description,
    risk: RISK[id] as PermissionPreset['risk'],
    requiresConfirmation: id === PRESET.fullAccess,
    ...switching,
  }
}
