import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { claudeConfigDir } from './claude-native-files.mjs'
import { sandboxCommand } from './command-sandbox.mjs'
import { dynamicToolCliNames } from './dynamic-tools.mjs'
import { isGoalTool } from './goal-tools.mjs'
import { activePermissionRoots, permissionToolName } from './permission-grants.mjs'
import {
  type FileSystemRules,
  normalizedPath,
  pathAccess,
  readOnlyRules,
  withWritableRoots,
} from './permission-profiles.mjs'
import { transcriptPlanSlug } from './plan-slug.mjs'
import { claudePlansLocation } from './runtime-config.mjs'
import { defaultSandboxPolicy, type RuntimeSandboxPolicy } from './sandbox-policy.mjs'
import { shellEnvironmentCommand } from './shell-environment.mjs'
import type { RuntimeTurnContext } from './types.mjs'

const readTools = new Set([
  'Read',
  'Glob',
  'Grep',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'TodoWrite',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'WebFetch',
  'WebSearch',
])
const fileTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// 只读文件、列目录、搜文件的工具
const fileReadTools = new Set(['Read', 'NotebookRead', 'LS', 'Glob', 'Grep'])

export function isFileReadTool(name: string): boolean {
  return fileReadTools.has(name)
}

export function isFileEditTool(name: string): boolean {
  return fileTools.has(name)
}
export type OriginalBashInputs = Map<string, Record<string, unknown>>

function isStructuredOutput(context: RuntimeTurnContext, name: string): boolean {
  // 仅放行本轮明确启用的 SDK 输出格式工具，不能豁免同名外部工具。
  if (name !== 'StructuredOutput' || !context.outputFormat) return false
  const format = context.outputFormat as Record<string, unknown>
  return (
    format.type === 'json_schema' &&
    typeof format.schema === 'object' &&
    format.schema !== null &&
    !Array.isArray(format.schema)
  )
}

function policyFor(context: RuntimeTurnContext): RuntimeSandboxPolicy {
  const policy = context.sandboxPolicy ?? defaultSandboxPolicy(context.sandboxMode, context.cwd)
  return policy.type === 'dangerFullAccess'
    ? policy
    : {
        ...policy,
        networkAccess: policy.networkAccess || context.permissionGrants?.networkAccess === true,
      }
}

function writableRoots(context: RuntimeTurnContext): string[] {
  const policy = policyFor(context)
  if (policy.type !== 'workspaceWrite') return activePermissionRoots(context.permissionGrants)
  return [
    context.cwd,
    ...policy.writableRoots,
    ...activePermissionRoots(context.permissionGrants),
    ...(policy.excludeSlashTmp ? [] : ['/tmp']),
    ...(policy.excludeTmpdirEnvVar || !process.env.TMPDIR ? [] : [process.env.TMPDIR]),
  ].map(normalizedPath)
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export function sandboxedBashInput(context: RuntimeTurnContext, original: Record<string, unknown>) {
  // 先按 shell_environment_policy 组环境（shell-environment.mts），再套沙箱
  const input =
    context.shellEnvironment && typeof original.command === 'string'
      ? {
          ...original,
          command: shellEnvironmentCommand(context.shellEnvironment, original.command),
        }
      : original
  const policy = context.planMode
    ? { type: 'readOnly' as const, networkAccess: false }
    : policyFor(context)
  if (policy.type === 'dangerFullAccess') return input
  const command = sandboxCommand(
    ['/bin/bash', '--noprofile', '--norc', '-c', String(input.command)],
    context.cwd,
    { sandboxPolicy: policy },
    context.cwd,
    context.planMode ? [] : activePermissionRoots(context.permissionGrants),
    context.fileSystem && context.planMode ? readOnlyRules(context.fileSystem) : context.fileSystem,
  )
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return { ...input, command: command.map(quote).join(' '), dangerouslyDisableSandbox: false }
}

export function planDirectory(context: RuntimeTurnContext): string {
  // 放 CLI 自己的默认位置（CHA_CLAUDE_PLANS_LOCATION=config）时是配置目录下的 plans，各会话的计划文件名不同
  if (claudePlansLocation() === 'config') return join(claudeConfigDir(), 'plans')
  // SDK plansDirectory 只接受项目内目录；每个线程仍有独立的计划命名空间。
  return resolve(context.cwd, '.claude', 'plans', 'codex-harness-adapter', context.threadId)
}

/** 线程号 → 本会话 CLI 的计划文件（`<配置目录>/plans/<slug>.md`，解析过符号链接）。只在 config 模式下用 */
const sessionPlanFiles = new Map<string, string>()

/**
 * config 模式下，计划模式里要写 `<配置目录>/plans/` 下的文件时，先从会话记录里认出本会话的 slug（plan-slug.mts），
 * 记下本会话的计划文件，isPlanFile 只认这一个：别的会话、宿主 Claude Code 自己的计划文件，以及不是 `.md` 的，
 * 都按普通文件走沙箱。PreToolUse 钩子在判定之前调用
 */
export async function notePlanFile(
  context: RuntimeTurnContext,
  name: string,
  input: Record<string, unknown>,
  transcriptPath: unknown,
): Promise<void> {
  if (claudePlansLocation() !== 'config' || !context.planMode || !fileTools.has(name)) return
  if (typeof input.file_path !== 'string' || typeof transcriptPath !== 'string') return
  const root = normalizedPath(planDirectory(context))
  if (dirname(normalizedPath(resolve(context.cwd, input.file_path))) !== root) return
  const slug = await transcriptPlanSlug(transcriptPath)
  if (slug) sessionPlanFiles.set(context.threadId, join(root, `${slug}.md`))
}

export function isPlanFile(
  context: RuntimeTurnContext,
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (!context.planMode || !fileTools.has(name) || typeof input.file_path !== 'string') return false
  const root = normalizedPath(planDirectory(context))
  const target = normalizedPath(resolve(context.cwd, input.file_path))
  // 配置目录下的 plans 是各会话共用的，只豁免本会话 CLI 这次的那一个计划文件（notePlanFile 记下的）
  if (claudePlansLocation() === 'config') return sessionPlanFiles.get(context.threadId) === target
  const rootWithinProject = relative(normalizedPath(context.cwd), root)
  if (
    rootWithinProject === '..' ||
    rootWithinProject.startsWith(`..${sep}`) ||
    isAbsolute(rootWithinProject)
  )
    return false
  const child = relative(root, target)
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

// 按路径读文件、列目录、搜文件的工具，和它们给路径的参数
const readPathKeys: Record<string, string[]> = {
  Read: ['file_path'],
  NotebookRead: ['notebook_path'],
  NotebookEdit: ['notebook_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  LS: ['path'],
  Glob: ['path'],
  Grep: ['path'],
}

// 禁读检查：目标本身（按字面路径和真实路径各算一次）落在 deny 里就拒绝；Glob、Grep 是在一个目录下
// 往下搜，搜索范围里只要有禁读的目录也拒绝（CLI 自己执行搜索，没法把结果里的禁读路径滤掉）
function deniedRead(
  rules: FileSystemRules,
  cwd: string,
  name: string,
  input: Record<string, unknown>,
): string | null {
  const keys = readPathKeys[name]
  if (!keys) return null
  const search = name === 'Glob' || name === 'Grep'
  const targets = keys
    .map((key) => input[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (search && targets.length === 0) targets.push('.')
  // pattern 里带 `..` 能搜到 path 之外，搜索范围就算不准了，直接拒绝
  if (
    name === 'Glob' &&
    typeof input.pattern === 'string' &&
    input.pattern.split(/[\\/]/).includes('..')
  )
    return '当前权限档位下 Glob 的 pattern 不能带 ..'
  // Glob 的 pattern 写成绝对路径时，搜索范围是它开头不带通配符的那一段
  if (name === 'Glob' && typeof input.pattern === 'string' && isAbsolute(input.pattern)) {
    const parts = input.pattern.split('/')
    const first = parts.findIndex((part) => /[*?[\]{}]/.test(part))
    targets.push(first < 0 ? input.pattern : parts.slice(0, first).join('/') || '/')
  }
  for (const target of targets) {
    const logical = resolve(cwd, target)
    const real = normalizedPath(logical)
    if (pathAccess(rules, logical) === 'deny' || pathAccess(rules, real) === 'deny')
      return '当前权限档位禁止读取该路径'
    if (search) {
      const hidden = rules.entries.find(
        (entry) => entry.access === 'deny' && entry.path !== real && inside(real, entry.path),
      )
      if (hidden) return `搜索范围包含禁止读取的 ${hidden.path}，请换一个不含它的目录`
    }
  }
  return null
}

// 文件类工具在 CLI 进程里跑，Read `/proc/self/environ` 读到的是 CLI 自己的整份环境（模型的凭据、
// shell_environment_policy 挡在命令外面的令牌），`/proc/<pid>/` 下还有别的进程的。用了自定义档位或
// shell_environment_policy 的会话，文件类工具一律不碰 /proc（搜索范围含 /proc 的也拒绝）；命令在沙箱里
// 只看得到自己 PID 命名空间的 /proc，不受这条影响
function fileToolRules(context: RuntimeTurnContext): FileSystemRules | null {
  if (process.platform !== 'linux' || (!context.fileSystem && !context.shellEnvironment))
    return context.fileSystem ?? null
  const base = context.fileSystem ?? {
    entries: [{ path: '/', access: 'read' as const }],
    networkAccess: false,
    workspaceRoots: [],
  }
  return { ...base, entries: [...base.entries, { path: '/proc', access: 'deny' }] }
}

// 放在 PreToolUse，避免 SDK 自带 allow 规则或 acceptEdits 绕过 canUseTool。
export function deniedTool(
  context: RuntimeTurnContext,
  name: string,
  input: Record<string, unknown>,
): string | null {
  // 原生计划文件保存在会话专属目录，只豁免此文件，不豁免项目源码或符号链接外逃。
  if (isPlanFile(context, name, input)) return null
  if (isStructuredOutput(context, name)) return null
  if (context.goalTools && isGoalTool(name)) return null
  if (context.permissionTools && name === permissionToolName) return null
  // 动态工具由客户端执行，不归这边的沙箱和计划模式管（dynamic-tools.mts 的 dynamicToolCliNames）
  if (dynamicToolCliNames(context.dynamicTools).has(name)) return null
  const policy = policyFor(context)
  if (
    ['WebFetch', 'WebSearch'].includes(name) &&
    (context.planMode || (policy.type !== 'dangerFullAccess' && !policy.networkAccess))
  )
    return '当前策略禁止工具访问网络'
  if (name === 'Bash' && typeof input.command !== 'string') return '命令必须是字符串'
  const readRules = fileToolRules(context)
  if (readRules) {
    const reason = deniedRead(readRules, context.cwd, name, input)
    if (reason) return reason
  }
  if (context.planMode || (context.sandboxMode === 'read-only' && !fileTools.has(name)))
    return readTools.has(name) || name === 'Bash'
      ? null
      : '当前会话只允许读取，不允许有副作用的工具'
  if (!['danger-full-access', 'workspace-write', 'read-only'].includes(String(context.sandboxMode)))
    return '未知权限模式，拒绝执行'
  if (context.sandboxMode !== 'danger-full-access' && fileTools.has(name)) {
    const target = input.file_path ?? input.notebook_path
    if (typeof target !== 'string') return '文件工具缺少目标路径'
    const path = normalizedPath(resolve(context.cwd, target))
    const writable = context.fileSystem
      ? pathAccess(
          withWritableRoots(context.fileSystem, activePermissionRoots(context.permissionGrants)),
          path,
        ) === 'write'
      : writableRoots(context).some((root) => inside(root, path))
    if (!writable) return '文件路径超出授权目录'
  }
  return null
}

export function runtimePermissionOptions(
  context: RuntimeTurnContext,
  originals: OriginalBashInputs = new Map(),
): Record<string, unknown> {
  // 计划模式用每次工具调用的动态 hook 限制；退出计划不能解除用户选择的沙箱。
  return {
    // SDK 的默认沙箱会额外放行临时目录，并合并用户 allow 规则。
    // 模型命令统一经过精确策略的 OS 包装器，不能因原生设置而扩大边界。
    sandbox: { enabled: false },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (event: Record<string, unknown>, toolUseId: string) => {
              await notePlanFile(
                context,
                String(event.tool_name),
                (event.tool_input ?? {}) as Record<string, unknown>,
                event.transcript_path,
              )
              const structuredOutput =
                isStructuredOutput(context, String(event.tool_name)) ||
                Boolean(context.goalTools && isGoalTool(String(event.tool_name))) ||
                Boolean(context.permissionTools && event.tool_name === permissionToolName)
              let reason =
                event.agent_id &&
                (['EnterPlanMode', 'ExitPlanMode'].includes(String(event.tool_name)) ||
                  isGoalTool(String(event.tool_name)) ||
                  event.tool_name === permissionToolName)
                  ? '子代理不能修改父会话的计划模式、目标或权限'
                  : deniedTool(
                      context,
                      String(event.tool_name),
                      (event.tool_input ?? {}) as Record<string, unknown>,
                    )
              let updatedInput: Record<string, unknown> | undefined
              if (!reason && event.tool_name === 'Bash') {
                const input = (event.tool_input ?? {}) as Record<string, unknown>
                try {
                  updatedInput = sandboxedBashInput(context, input)
                  originals.set(toolUseId, input)
                } catch (error) {
                  reason = '无法建立命令沙箱，禁止执行：' + String(error)
                }
              }
              return reason
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: reason,
                    },
                  }
                : structuredOutput
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'allow',
                      },
                    }
                  : context.approvalPolicy === 'untrusted' &&
                      !readTools.has(String(event.tool_name)) &&
                      !isPlanFile(
                        context,
                        String(event.tool_name),
                        (event.tool_input ?? {}) as Record<string, unknown>,
                      )
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'ask',
                          ...(updatedInput ? { updatedInput } : {}),
                        },
                      }
                    : updatedInput
                      ? {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            updatedInput,
                            ...(context.planMode || context.sandboxMode === 'read-only'
                              ? { permissionDecision: 'allow' }
                              : {}),
                          },
                        }
                      : {}
            },
          ],
        },
      ],
    },
  }
}
