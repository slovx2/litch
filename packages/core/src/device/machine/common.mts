// 各个工具共用的：找机器、审批、看路径（真实路径加禁止位置）、出错时给模型的说明。
// 每个工具的处理函数回一个 Outcome：答复加上要记的那一条操作记录，executor.mts 统一记，一次调用正好一条。
import {
  type ClientToolCallResponse,
  type ClientToolContentItem,
  type ClientToolFailureKind,
  clientToolFailure,
} from '../../../../protocol/src/client-tools.mjs'
import { MACHINE_ID } from '../../../../protocol/src/client-tools-machine.mjs'
import type { Clock } from '../../channel/protocol.mjs'
import { RpcAbortError, RpcError } from '../../connection/rpc.mjs'
import type { MachineAskView } from '../../model-machine.mjs'
import { decodeUtf8 } from '../../text/bytes.mjs'
import {
  blockedBy,
  cleanReal,
  type DeniedRule,
  expandPath,
  expandRules,
  foldCase,
} from './paths.mjs'
import type { Runner } from './runner.mjs'
import {
  type ProbeResult,
  parseProbe,
  runScript,
  ScriptError,
  scriptCommand,
  splitBytes,
} from './scripts.mjs'
import type {
  MachineApprovalRequest,
  MachineCallContext,
  MachineFacts,
  MachineLogNote,
  MachineTarget,
} from './types.mjs'

export interface ToolKit {
  clock: Clock
  runner: Runner
  context: MachineCallContext
  debug(line: string): void
}

/** 一个工具处理完：答复和要记的那一条（tool 由 executor 补） */
export interface Outcome {
  response: ClientToolCallResponse
  note: Omit<MachineLogNote, 'tool'>
}

export const done = (
  text: string,
  summary: string,
  flagged = false,
  more: ClientToolContentItem[] = [],
): Outcome => ({
  response: { success: true, contentItems: [{ type: 'inputText', text }, ...more] },
  note: { summary, result: 'ok', flagged },
})

export const failed = (
  kind: ClientToolFailureKind,
  message: string,
  summary: string,
  flagged = false,
): Outcome => ({
  response: clientToolFailure(kind, message),
  note: {
    summary,
    result: kind === 'blocked' ? 'blocked' : kind === 'declined' ? 'declined' : 'failed',
    flagged,
  },
})

/** 参数不对（参数不是对象、缺了必填的）。给模型的说明里写清是哪个 */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArgumentError'
  }
}

export function asObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args))
    return args as Record<string, unknown>
  if (args == null) return {}
  throw new ArgumentError('arguments must be an object')
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || !value)
    throw new ArgumentError(`${key} must be a non-empty string`)
  return value
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new ArgumentError(`${key} must be a string`)
  return value
}

export function optionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = args[key]
  if (value == null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ArgumentError(`${key} must be an integer from ${min} to ${max}`)
  return value
}

/** 按 machine 参数找机器（省略就是桌面端）。找不到抛 ArgumentError，说明里叫模型先 machines */
export function targetOf(context: MachineCallContext, machine: unknown): MachineTarget {
  if (machine != null && typeof machine !== 'string')
    throw new ArgumentError('machine must be a string')
  const id = machine || MACHINE_ID.desktop
  const target = context.target(id)
  if (!target)
    throw new ArgumentError(
      `machine "${id}" is unknown or offline. Call machines to list the machines you can operate.`,
    )
  return target
}

/** 机器的情况。取不到抛错（连接不在） */
export async function factsOf(target: MachineTarget): Promise<MachineFacts> {
  return target.facts()
}

/** 用户点头了是 null；没点头就是给模型的失败（被拒的别重试） */
export async function approved(
  kit: ToolKit,
  request: MachineApprovalRequest,
  summary: string,
): Promise<Outcome | null> {
  const flagged = request.ask.flagged.length > 0
  const answer = await kit.context.approve(request)
  if (answer.kind === 'allowed') return null
  if (answer.kind === 'declined') {
    const note = answer.note?.trim()
    return failed(
      'declined',
      `The user declined this on the desktop${note ? `: "${note}"` : '.'} Do not retry the same call; follow the user's note or ask them.`,
      summary,
      flagged,
    )
  }
  if (answer.kind === 'expired') {
    const out = failed(
      'declined',
      'The user did not answer on the desktop in time, so this was not done. Do not retry it right away; ask the user first.',
      summary,
      flagged,
    )
    out.note.result = 'expired'
    return out
  }
  return failed('failed', 'The call was cancelled before the user answered.', summary, flagged)
}

export const askView = (
  partial: Partial<MachineAskView> & Pick<MachineAskView, 'action'>,
): MachineAskView => ({
  kind: 'machine',
  command: null,
  cwd: null,
  path: null,
  copy: null,
  flagged: [],
  ...partial,
})

/** 一个路径看过之后的样子：展开的路径、真实路径、种类大小，和桌面端这台挡它的那条禁止位置 */
export interface LookedPath {
  path: string
  probe: ProbeResult
  rules: DeniedRule[]
  blocked: DeniedRule | null
  icase: boolean
}

/** probe 的输出不大，留这么多够了 */
const PROBE_COLLECT = 64 * 1024

/**
 * 看一个路径：在目标机器上解真实路径、取种类和大小；目标是桌面端时连同禁止位置一起解，算出挡没挡。
 * path 是模型给的原样（可以以 ~ 开头），不是绝对路径抛 ArgumentError
 */
export async function lookPath(
  kit: ToolKit,
  target: MachineTarget,
  facts: MachineFacts,
  raw: string,
  key = 'path',
): Promise<LookedPath> {
  const path = expandPath(raw, facts.home)
  if (!path) throw new ArgumentError(`${key} must be an absolute path or start with ~`)
  const desktop = target.role === 'desktop'
  const expanded = desktop ? expandRules(kit.context.policy.denied, facts.home) : []
  const result = await runScript(
    kit.runner,
    target,
    scriptCommand.probe(
      path,
      expanded.map((rule) => rule.expanded),
    ),
    { collect: PROBE_COLLECT },
  )
  const fields = splitBytes(result.stdout, [0]).map((bytes) => decodeUtf8(bytes))
  const probe = parseProbe(fields, expanded.length)
  probe.real = cleanReal(probe.real)
  const rules = expanded.map((rule, at) => ({
    ...rule,
    real: cleanReal(probe.denied[at] ?? rule.expanded),
  }))
  const icase = foldCase(facts.system)
  // 展开的写法也比：真实路径在别处（比如经符号链接）时，按写法落在禁止位置里的照样挡
  const blocked = blockedBy(probe.real, rules, icase) ?? blockedBy(path, rules, icase)
  return { path, probe, rules, blocked, icase }
}

export const blockedMessage = (looked: LookedPath): string => {
  const rule = looked.blocked
  if (!rule) return ''
  const where = looked.probe.real !== looked.path ? ` (it resolves to ${looked.probe.real})` : ''
  return `${looked.path}${where} is inside a location the user blocked on the desktop: "${rule.rule}". Litch's access settings for this device do not allow it. Do not try to reach it another way; ask the user if you need it.`
}

/** 出错了给模型的说明 */
export function errorText(error: unknown): string {
  if (error instanceof ArgumentError || error instanceof ScriptError) return error.message
  if (error instanceof RpcAbortError) {
    if (error.reason === 'closed') return 'the connection to the machine was lost'
    if (error.reason === 'timeout') return 'the machine did not answer in time'
    return 'cancelled'
  }
  if (error instanceof RpcError) return error.message
  return error instanceof Error ? error.message : String(error)
}
