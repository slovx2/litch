// 入口参数与跨字段引用校验。模型的 schema 不是权限边界，设备仍逐项检查。
import { Ajv } from 'ajv'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import type { ManagerCreateParams, ManagerPatch } from '../../protocol/src/manager.mjs'
import { MANAGER_SITUATION_LIMIT } from '../../protocol/src/manager.mjs'
import {
  type ManagerValidationIssue,
  managerInputIssue,
} from '../../protocol/src/manager-validation.mjs'
import { DirectoryError, requireDeviceDirectory } from './directory-validation.mjs'
import { isObject } from './wire.mjs'

export class ManagerError extends Error {
  readonly code: number
  readonly data: Record<string, unknown>
  constructor(reason: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.code =
      reason === 'methodNotFound'
        ? -32601
        : [
              'managerEnded',
              'decisionNotClosed',
              'decisionNotOpen',
              'decisionConflict',
              'lineLimitReached',
            ].includes(reason)
          ? -32600
          : -32602
    this.data = { litch: reason, ...detail }
  }
}
export function invalid(message: string, field?: string): never {
  throw new ManagerError('invalidManager', message, field ? { field } : {})
}
export function fields(value: unknown): Record<string, unknown> {
  if (!isObject(value)) invalid('Expected an object.')
  return value
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) invalid(`Unknown field: ${key}.`, key)
}
export function text(value: unknown, field: string, nonempty = true): string {
  if (typeof value !== 'string' || (nonempty && !value.trim()))
    invalid(`${field} must be ${nonempty ? 'nonempty ' : ''}text.`, field)
  return value
}
export function invalidSetting(issue: ManagerValidationIssue): never {
  const { message, ...detail } = issue
  throw new ManagerError('invalidManager', message, { ...detail, litch: 'invalidManager' })
}
export function validatePatch(value: Record<string, unknown>): ManagerPatch {
  const issue = managerInputIssue(value, 'patch')
  if (issue) invalidSetting(issue)
  return value as ManagerPatch
}
export function validateCreate(value: unknown): ManagerCreateParams {
  const issue = managerInputIssue(value, 'create')
  if (issue) invalidSetting(issue)
  const given = value as ManagerCreateParams
  try {
    return { ...given, cwd: requireDeviceDirectory(given.cwd) }
  } catch (error) {
    if (error instanceof DirectoryError) invalidSetting({ ...error.data, message: error.message })
    throw error
  }
}
const ajv = new Ajv({ strict: false, allErrors: true })
const validators = new Map(
  MANAGER_TOOLS.tools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
)
// 从同一份字段定义取可改字段，不另维护一份随协议漂移的白名单。
const addProperties = fields(
  MANAGER_TOOLS.tools.find((tool) => tool.name === 'add')?.inputSchema.properties,
)
const patchKeys = new Map(
  ['decision', 'item', 'request'].map((kind) => [
    kind,
    Object.keys(fields(fields(addProperties[kind]).properties)),
  ]),
)
export function validateTool(tool: string, args: unknown): Record<string, unknown> {
  if (tool === 'status' && isObject(args) && typeof args.text === 'string') {
    const length = Array.from(args.text).length
    if (length > MANAGER_SITUATION_LIMIT)
      invalid(
        `Situation contains ${length} characters; maximum is ${MANAGER_SITUATION_LIMIT}.`,
        'text',
      )
  }
  const validator = validators.get(tool)
  if (!validator) invalid(`Unknown litch_manager tool: ${tool}.`)
  if (!validator(args)) invalid(`Invalid ${tool} arguments: ${ajv.errorsText(validator.errors)}.`)
  const input = fields(args)
  // 工具顶层不能使用组合关键字；设备补齐原先分支 schema 的 kind 约束。
  if (tool === 'add') {
    const kind = input.kind as string
    const others = ['decision', 'item', 'request'].filter((one) => one !== kind)
    if (!(kind in input)) invalid(`For kind=${kind}, ${kind} is required.`, kind)
    for (const other of others)
      if (other in input) invalid(`For kind=${kind}, omit ${other}.`, other)
  }
  if (tool === 'update') {
    const allowed = patchKeys.get(input.kind as string) ?? []
    for (const key of Object.keys(fields(input.patch)))
      if (!allowed.includes(key))
        invalid(`patch.${key} is not allowed for kind=${input.kind}.`, `patch.${key}`)
  }
  if (tool === 'close') {
    const statuses =
      input.kind === 'decision'
        ? ['expired', 'withdrawn']
        : input.kind === 'request'
          ? ['cancelled']
          : ['done', 'deferred']
    if (!statuses.includes(input.status as string))
      invalid(`For kind=${input.kind}, status must be ${statuses.join(' or ')}.`, 'status')
  }
  if (['add', 'update'].includes(tool) && input.kind === 'item') {
    const owner = fields(tool === 'add' ? input.item : input.patch).owner
    if (owner && fields(owner).kind === 'user')
      invalid(
        'Items record manager or line progress. Use litch_sessions.start with initiation propose for work requiring user initiation; owner.kind=user is not allowed.',
      )
  }
  if (input.kind === 'request') {
    if (
      !Number.isSafeInteger(input.revision) ||
      (tool === 'add' ? input.revision !== 0 : Number(input.revision) < 1)
    )
      invalid(
        'For request, supply revision=0 when adding or the current revision when updating/cancelling.',
      )
    text(tool === 'close' ? input.reason : input.why, tool === 'close' ? 'reason' : 'why')
  }
  return input
}
