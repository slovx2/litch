// 入口参数与跨字段引用校验。模型的 schema 不是权限边界，设备仍逐项检查。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Ajv } from 'ajv'
import { MANAGER_TOOLS } from '../../protocol/src/client-tools-manager.mjs'
import type { ManagerCreateParams, ManagerPatch } from '../../protocol/src/manager.mjs'
import { isObject } from './wire.mjs'

export class ManagerError extends Error {
  readonly code: number
  readonly data: Record<string, unknown>
  constructor(reason: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.code = ['managerEnded', 'decisionNotClosed', 'lineLimitReached'].includes(reason)
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
function nullable(value: unknown, field: string): void {
  if (value !== null) text(value, field)
}

const PATCH = ['name', 'scope', 'rules', 'dispatch', 'contact']
export function validatePatch(value: Record<string, unknown>): ManagerPatch {
  keys(value, PATCH)
  for (const key of ['name', 'scope', 'rules'])
    if (key in value) text(value[key], key, key === 'scope')
  if ('dispatch' in value) {
    const dispatch = fields(value.dispatch)
    keys(dispatch, ['harness', 'model', 'effort', 'worktree', 'merge', 'maxRunningLines'])
    for (const key of ['harness', 'model', 'effort']) nullable(dispatch[key], `dispatch.${key}`)
    if (typeof dispatch.worktree !== 'boolean') invalid('dispatch.worktree must be boolean.')
    if (!['manager', 'user'].includes(String(dispatch.merge)))
      invalid('dispatch.merge must be manager or user.')
    if (!Number.isSafeInteger(dispatch.maxRunningLines) || Number(dispatch.maxRunningLines) < 1)
      invalid('dispatch.maxRunningLines must be a positive integer.')
  }
  if ('contact' in value) {
    const contact = fields(value.contact)
    keys(contact, ['desktopNotification', 'unanswered'])
    if (typeof contact.desktopNotification !== 'boolean' || contact.unanswered !== 'wait')
      invalid('contact requires desktopNotification and unanswered=wait.')
  }
  return value as ManagerPatch
}
export function validateCreate(value: unknown): ManagerCreateParams {
  const input = fields(value)
  keys(input, [...PATCH, 'cwd', 'harness', 'model', 'effort', 'template', 'firstTask'])
  for (const key of ['cwd', 'harness', 'scope', 'name', 'rules', 'firstTask'])
    text(input[key], key, ['cwd', 'harness', 'scope'].includes(key))
  for (const key of ['model', 'effort']) nullable(input[key], key)
  if (!['release', 'investigation', 'research', 'blank'].includes(String(input.template)))
    invalid('Unknown manager template.', 'template')
  validatePatch(Object.fromEntries(PATCH.map((key) => [key, input[key]])))
  const cwd = input.cwd as string
  if (!isAbsolute(cwd)) invalid('cwd must be an absolute directory.', 'cwd')
  try {
    if (!statSync(cwd).isDirectory()) invalid('cwd must be a directory.', 'cwd')
  } catch {
    invalid('cwd must be an existing directory on this device.', 'cwd')
  }
  return input as unknown as ManagerCreateParams
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
  ['decision', 'item'].map((kind) => [
    kind,
    Object.keys(fields(fields(addProperties[kind]).properties)),
  ]),
)
export function validateTool(tool: string, args: unknown): Record<string, unknown> {
  const validator = validators.get(tool)
  if (!validator) invalid(`Unknown litch_manager tool: ${tool}.`)
  if (!validator(args)) invalid(`Invalid ${tool} arguments: ${ajv.errorsText(validator.errors)}.`)
  const input = fields(args)
  // 工具顶层不能使用组合关键字；设备补齐原先分支 schema 的 kind 约束。
  if (tool === 'add') {
    const kind = input.kind as string
    const other = kind === 'decision' ? 'item' : 'decision'
    if (!(kind in input)) invalid(`For kind=${kind}, ${kind} is required.`, kind)
    if (other in input) invalid(`For kind=${kind}, omit ${other}.`, other)
  }
  if (tool === 'update') {
    const allowed = patchKeys.get(input.kind as string) ?? []
    for (const key of Object.keys(fields(input.patch)))
      if (!allowed.includes(key))
        invalid(`patch.${key} is not allowed for kind=${input.kind}.`, `patch.${key}`)
  }
  if (tool === 'close') {
    const statuses = input.kind === 'decision' ? ['expired', 'withdrawn'] : ['done', 'deferred']
    if (!statuses.includes(input.status as string))
      invalid(`For kind=${input.kind}, status must be ${statuses.join(' or ')}.`, 'status')
  }
  return input
}
