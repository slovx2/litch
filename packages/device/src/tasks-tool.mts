// litch_tasks 工具（client-tools-tasks.mts）的执行方：设备进程自己。
// 调用从哪来都到这里：客户端连接对应的上游连接（relay.mts 截下，原生 codex 的经 client-tools.mts 的路由）、
// 任务自己的内部连接（task-link.mts）。原生 codex 把同一次调用发给每条订阅着会话的连接，
// 这里按 harness + 会话 + callId 只答第一份，其余几份不答（答复从哪条连接回去都算数）。
// 结果是一段 JSON 文本；出错是 [litch:<kind>] 开头的一句英文说明（同 clientTools 扩展的失败答复）。
import { type ClientToolCallResponse, clientToolFailure } from '../../protocol/src/client-tools.mjs'
import type { TaskSessionSettings, TaskTarget } from '../../protocol/src/device-tasks.mjs'
import type { HarnessSource } from './session.mjs'
import { connectEngine, type TaskTiming } from './task-run.mjs'
import { DeviceTaskError } from './task-validate.mjs'
import type { DeviceTasks } from './tasks.mjs'
import { type Frame, isObject } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'

/** 答过的调用记多久（毫秒）。原生 codex 的几份前后只差几毫秒，恢复会话时补发的也在回合之内 */
const REMEMBER_MS = 30 * 60 * 1000

/** 沙箱类型到内置权限档（同客户端核心的 projectSettings） */
const SANDBOX_PRESET: Record<string, string> = {
  readOnly: ':read-only',
  workspaceWrite: ':workspace',
  dangerFullAccess: ':danger-full-access',
}

export interface TasksToolOptions {
  /** 任务模块。打不开任务库时是 null */
  tasks(): DeviceTasks | null
  harnesses(): HarnessSource[]
  workspaces: Workspaces
  version: string
  timing: TaskTiming
  log(line: string): void
}

const ok = (value: unknown): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

export class TasksTool {
  private readonly options: TasksToolOptions
  private readonly answered = new Map<string, number>()

  constructor(options: TasksToolOptions) {
    this.options = options
  }

  /** 一次 litch_tasks 调用。同一次调用的别的几份不答 */
  answer(harness: string, frame: Frame, reply: (result: ClientToolCallResponse) => void): void {
    const params = isObject(frame.params) ? frame.params : {}
    const threadId = typeof params.threadId === 'string' ? params.threadId : ''
    const callId = typeof params.callId === 'string' ? params.callId : String(frame.id)
    const key = [harness, threadId, callId].join('\u0000')
    const now = Date.now()
    for (const [old, at] of this.answered) if (now - at > REMEMBER_MS) this.answered.delete(old)
    if (this.answered.has(key)) return
    this.answered.set(key, now)
    const tool = typeof params.tool === 'string' ? params.tool : ''
    this.execute(harness, threadId, tool, params.arguments).then(reply, (error) =>
      reply(clientToolFailure('failed', `The task tool failed: ${String(error)}`)),
    )
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
          return ok({ task: tasks.update(change) })
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
    const source = this.options.harnesses().find((item) => item.id === harness)
    if (!source) return { cwd: null, settings }
    const link = await connectEngine(
      source,
      {
        version: this.options.version,
        timing: this.options.timing,
        // 原生 codex 会把还在等的这一次调用补发给恢复会话的连接：同一次调用，answer 认得出来，不再答
        toolCall: () => {},
      },
      () => {},
      () => {},
    )
    try {
      const timeout = this.options.timing.requestTimeoutMs
      const resumed = await link.call('thread/resume', { threadId }, timeout).catch(() => null)
      const read =
        resumed ?? (await link.call('thread/read', { threadId }, timeout).catch(() => null))
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
