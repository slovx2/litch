import { type DirectoryValidationReason, deviceDirectoryPath } from './directory-validation.mjs'

// 客户端与设备共用的纯参数校验；目录存在性、引擎可用性仍由目标设备检查。
export type ManagerValidationReason =
  | 'object'
  | 'unknownField'
  | 'text'
  | 'required'
  | 'boolean'
  | 'choice'
  | 'positiveInteger'
  | DirectoryValidationReason
  | 'unavailableHarness'
  | 'unsupportedPermission'
  | 'unavailableModel'
  | 'unsupportedEffort'
  | 'catalogUnavailable'

export interface ManagerValidationIssue {
  field: string
  reason: ManagerValidationReason
  message: string
  /** 目录错误保留用户输入及设备解析结果；客户端不能代替远程设备展开 home。 */
  value?: string
  resolvedPath?: string
}

const PATCH = ['name', 'scope', 'rules', 'dispatch', 'contact']
const CREATE = [
  ...PATCH,
  'cwd',
  'harness',
  'model',
  'effort',
  'permission',
  'template',
  'firstTask',
]
const DISPATCH = ['harness', 'model', 'effort', 'worktree', 'merge', 'maxRunningLines']
const CONTACT = ['desktopNotification', 'unanswered']
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const managerPositiveInteger = (value: unknown): boolean =>
  Number.isSafeInteger(value) && Number(value) > 0

export interface ManagerModelChoice {
  id: string
  isDefault: boolean
  efforts: readonly string[]
}
/** 型号目录来自目标 harness；客户端和设备按相同规则检查显式选择。 */
export function managerSelectionIssue(
  models: readonly ManagerModelChoice[],
  model: string | null,
  effort: string | null,
  prefix = '',
): ManagerValidationIssue | null {
  const selected = model
    ? models.find((entry) => entry.id === model)
    : (models.find((entry) => entry.isDefault) ?? models[0])
  if (model && !selected)
    return {
      field: `${prefix}model`,
      reason: 'unavailableModel',
      message: `Model ${model} is not available on this harness.`,
    }
  if (effort && !selected?.efforts.includes(effort))
    return {
      field: `${prefix}effort`,
      reason: 'unsupportedEffort',
      message: `Reasoning effort ${effort} is not supported by the selected model.`,
    }
  return null
}

export function managerInputIssue(
  value: unknown,
  mode: 'create' | 'patch',
): ManagerValidationIssue | null {
  const issue = (field: string, reason: ManagerValidationReason, message: string) => ({
    field,
    reason,
    message,
  })
  const keys = (input: Record<string, unknown>, allowed: string[], prefix = '') => {
    const key = Object.keys(input).find((key) => !allowed.includes(key))
    return key ? issue(`${prefix}${key}`, 'unknownField', `Unknown field: ${prefix}${key}.`) : null
  }
  const text = (input: unknown, field: string, nonempty = false) =>
    typeof input !== 'string' || (nonempty && !input.trim())
      ? issue(
          field,
          nonempty ? 'required' : 'text',
          `${field} must be ${nonempty ? 'nonempty ' : ''}text.`,
        )
      : null
  if (!object(value)) return issue('', 'object', 'Expected an object.')
  let error = keys(value, mode === 'create' ? CREATE : PATCH)
  if (error) return error
  for (const field of [
    'name',
    'scope',
    'rules',
    ...(mode === 'create' ? ['cwd', 'harness', 'firstTask'] : []),
  ]) {
    if (mode === 'patch' && !(field in value)) continue
    error = text(value[field], field, field === 'cwd' || field === 'harness')
    if (error) return error
  }
  if (mode === 'create') {
    for (const field of ['model', 'effort', 'permission']) {
      if (value[field] === null || (field === 'permission' && value[field] === undefined)) continue
      error = text(value[field], field, true)
      if (error) return error
    }
    if (!['release', 'investigation', 'research', 'blank'].includes(value.template as string))
      return issue('template', 'choice', 'Unknown manager template.')
    if (!deviceDirectoryPath(value.cwd as string))
      return {
        ...issue('cwd', 'absolutePath', 'cwd must be an absolute directory or start with ~/.'),
        value: value.cwd as string,
      }
  }
  if (mode === 'create' || 'dispatch' in value) {
    const dispatch = value.dispatch
    if (!object(dispatch)) return issue('dispatch', 'object', 'dispatch must be an object.')
    error = keys(dispatch, DISPATCH, 'dispatch.')
    if (error) return error
    for (const field of ['harness', 'model', 'effort']) {
      if (dispatch[field] === null) continue
      error = text(dispatch[field], `dispatch.${field}`, true)
      if (error) return error
    }
    if (typeof dispatch.worktree !== 'boolean')
      return issue('dispatch.worktree', 'boolean', 'dispatch.worktree must be boolean.')
    if (!['manager', 'user'].includes(dispatch.merge as string))
      return issue('dispatch.merge', 'choice', 'dispatch.merge must be manager or user.')
    if (!managerPositiveInteger(dispatch.maxRunningLines))
      return issue(
        'dispatch.maxRunningLines',
        'positiveInteger',
        'dispatch.maxRunningLines must be a positive integer.',
      )
  }
  if (mode === 'create' || 'contact' in value) {
    const contact = value.contact
    if (!object(contact)) return issue('contact', 'object', 'contact must be an object.')
    error = keys(contact, CONTACT, 'contact.')
    if (error) return error
    if (typeof contact.desktopNotification !== 'boolean')
      return issue(
        'contact.desktopNotification',
        'boolean',
        'contact.desktopNotification must be boolean.',
      )
    if (contact.unanswered !== 'wait')
      return issue('contact.unanswered', 'choice', 'contact.unanswered must be wait.')
  }
  return null
}
