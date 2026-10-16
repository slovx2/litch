import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { sandboxCommand } from './command-sandbox.mjs'
import { isGoalTool } from './goal-tools.mjs'
import { activePermissionRoots, permissionToolName } from './permission-grants.mjs'
import { defaultSandboxPolicy, type RuntimeSandboxPolicy } from './sandbox-policy.mjs'
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
  ].map(resolvedTarget)
}

function inside(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export function sandboxedBashInput(context: RuntimeTurnContext, input: Record<string, unknown>) {
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
  )
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  return { ...input, command: command.map(quote).join(' '), dangerouslyDisableSandbox: false }
}

export function planDirectory(context: RuntimeTurnContext): string {
  // SDK plansDirectory 只接受项目内目录；每个线程仍有独立的计划命名空间。
  return resolve(context.cwd, '.claude', 'plans', 'codex-harness-adapter', context.threadId)
}

export function isPlanFile(
  context: RuntimeTurnContext,
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (!context.planMode || !fileTools.has(name) || typeof input.file_path !== 'string') return false
  const root = resolvedTarget(planDirectory(context))
  const rootWithinProject = relative(resolvedTarget(context.cwd), root)
  if (
    rootWithinProject === '..' ||
    rootWithinProject.startsWith(`..${sep}`) ||
    isAbsolute(rootWithinProject)
  )
    return false
  const child = relative(root, resolvedTarget(resolve(context.cwd, input.file_path)))
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function resolvedTarget(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) return path
    return resolve(resolvedTarget(parent), relative(parent, path))
  }
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
  const policy = policyFor(context)
  if (
    ['WebFetch', 'WebSearch'].includes(name) &&
    (context.planMode || (policy.type !== 'dangerFullAccess' && !policy.networkAccess))
  )
    return '当前策略禁止工具访问网络'
  if (name === 'Bash' && typeof input.command !== 'string') return '命令必须是字符串'
  if (context.planMode || (context.sandboxMode === 'read-only' && !fileTools.has(name)))
    return readTools.has(name) || name === 'Bash'
      ? null
      : '当前会话只允许读取，不允许有副作用的工具'
  if (!['danger-full-access', 'workspace-write', 'read-only'].includes(String(context.sandboxMode)))
    return '未知权限模式，拒绝执行'
  if (context.sandboxMode !== 'danger-full-access' && fileTools.has(name)) {
    const target = input.file_path ?? input.notebook_path
    if (typeof target !== 'string') return '文件工具缺少目标路径'
    const path = resolvedTarget(resolve(context.cwd, target))
    if (!writableRoots(context).some((root) => inside(root, path))) return '文件路径超出授权目录'
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
