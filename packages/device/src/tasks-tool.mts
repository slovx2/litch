// litch_tasks 工具（client-tools-tasks.mts）的执行方：设备进程自己。注册进设备工具的注册表（device-tools.mts），
// 调用从哪来、同一次调用的几份只答一份，都由注册表管；这里只管一次调用怎么做。
// 结果是一段 JSON 文本；出错是 [litch:<kind>] 开头的一句英文说明（同 clientTools 扩展的失败答复）。
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import type { TaskSessionSettings, TaskTarget } from '../../protocol/src/device-tasks.mjs'
import type { DeviceToolCall, DeviceToolRegistry } from './device-tools.mjs'
import type { EngineLink } from './engine-link.mjs'
import { DeviceTaskError } from './task-validate.mjs'
import type { DeviceTasks } from './tasks.mjs'
import { isObject } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'

/** 沙箱类型到内置权限档（同客户端核心的 projectSettings） */
const SANDBOX_PRESET: Record<string, string> = {
  readOnly: ':read-only',
  workspaceWrite: ':workspace',
  dangerFullAccess: ':danger-full-access',
}

export interface TasksToolOptions {
  /** 任务模块。打不开任务库时是 null */
  tasks(): DeviceTasks | null
  workspaces: Workspaces
  /** 开一条内部连接（new_thread 要读发起调用的会话的设置） */
  openEngineLink(harness: string): Promise<EngineLink>
}

/** 把 litch_tasks 注册进设备工具的注册表 */
export function registerTasksTool(registry: DeviceToolRegistry, options: TasksToolOptions): void {
  const tool = new TasksTool(options)
  registry.register(CLIENT_TOOL_NAMESPACE.tasks, (call) => tool.handle(call))
}

const ok = (value: unknown): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

export class TasksTool {
  private readonly options: TasksToolOptions

  constructor(options: TasksToolOptions) {
    this.options = options
  }

  handle(call: DeviceToolCall): Promise<ClientToolCallResponse> {
    return this.execute(call.harness, call.threadId, call.tool, call.arguments)
  }

  private async execute(
    harness: string,
    threadId: string,
    tool: string,
    args: unknown,
  ): Promise<ClientToolCallResponse> {
    const tasks = this.options.tasks()
    if (!tasks)
      return clientToolFailure(
        'failed',
        'Scheduled tasks are not available on this device right now. Tell the user; do not retry.',
      )
    const fields = isObject(args) ? args : {}
    if (args != null && !isObject(args))
      return clientToolFailure('invalid', 'The arguments must be a JSON object.')
    try {
      switch (tool) {
        case 'list':
          return ok({ tasks: tasks.list() })
        case 'create': {
          const target = await this.target(harness, threadId, fields.target)
          const task = tasks.create(fields, target, { kind: 'tool', harness, threadId })
          return ok({ task })
        }
        case 'update': {
          const current = tasks.task(String(fields.id ?? ''))
          if (fields.status != null && fields.status !== 'active' && fields.status !== 'paused')
            return clientToolFailure('invalid', 'status must be active or paused.')
          const change: Record<string, unknown> = { id: current.id, revision: current.revision }
          for (const key of ['name', 'prompt', 'schedule', 'timezone', 'status'])
            if (fields[key] !== undefined) change[key] = fields[key]
          return ok({ task: await tasks.update(change) })
        }
        case 'delete': {
          const id = String(fields.id ?? '')
          tasks.delete(id)
          return ok({ deleted: id })
        }
        case 'run_now':
          return ok(tasks.runNow(String(fields.id ?? '')))
        default:
          return clientToolFailure(
            'invalid',
            `litch_tasks has no tool named ${tool}. Use list, create, update, delete or run_now.`,
          )
      }
    } catch (error) {
      if (error instanceof DeviceTaskError) {
        const field = error.data.field ? ` (field: ${error.data.field})` : ''
        return clientToolFailure('invalid', `${error.message}${field}.`)
      }
      return clientToolFailure(
        'failed',
        `${error instanceof Error ? error.message : String(error)}.`,
      )
    }
  }

  /**
   * create 的 target：this_thread（默认）在发起调用的会话里接着发；
   * new_thread 每次新建会话，沿用这个会话的 harness、目录、工作区和设置
   */
  private async target(harness: string, threadId: string, choice: unknown): Promise<TaskTarget> {
    if (choice != null && choice !== 'this_thread' && choice !== 'new_thread')
      throw new DeviceTaskError('invalidTask', 'target must be this_thread or new_thread', {
        field: 'target',
      })
    if (!threadId)
      throw new DeviceTaskError('invalidTarget', 'The call did not come from a thread', {
        field: 'target',
      })
    if (choice !== 'new_thread') return { kind: 'thread', harness, threadId }
    const { cwd, settings } = await this.inspect(harness, threadId)
    if (!cwd)
      throw new DeviceTaskError(
        'invalidTarget',
        'The working directory of this thread is unknown, so new_thread cannot be used',
        { field: 'target' },
      )
    return {
      kind: 'newThread',
      harness,
      cwd,
      workspaceId: this.options.workspaces.projectOf(threadId),
      settings,
    }
  }

  /** 这个会话的目录和设置：恢复它一下（只为看应答，随即关掉连接） */
  private async inspect(
    harness: string,
    threadId: string,
  ): Promise<{ cwd: string | null; settings: TaskSessionSettings }> {
    const settings: TaskSessionSettings = { model: null, effort: null, permission: null }
    let link: EngineLink
    try {
      link = await this.options.openEngineLink(harness)
    } catch {
      return { cwd: null, settings }
    }
    // 原生 codex 会把还在等的这一次调用补发给恢复会话的连接：同一次调用，注册表认得出来，不再答
    try {
      const resumed = await link.request('thread/resume', { threadId }).catch(() => null)
      const read = resumed ?? (await link.request('thread/read', { threadId }).catch(() => null))
      const response = isObject(read) ? read : {}
      const thread = isObject(response.thread) ? response.thread : {}
      settings.model = text(response.model)
      settings.effort = text(response.reasoningEffort)
      const presets = link.runtime?.permissionPresets
      if (Array.isArray(presets) && presets.length > 0) {
        const has = (id: string | null): id is string =>
          id !== null && presets.some((preset) => isObject(preset) && preset.id === id)
        const profile = response.activePermissionProfile
        const named = isObject(profile) ? text(profile.id) : text(profile)
        const sandbox = isObject(response.sandbox) ? text(response.sandbox.type) : null
        const guessed = sandbox ? (SANDBOX_PRESET[sandbox] ?? null) : null
        settings.permission = has(named) ? named : has(guessed) ? guessed : null
      } else settings.permission = text(response.approvalPolicy)
      return { cwd: text(thread.cwd), settings }
    } finally {
      link.close()
    }
  }
}
