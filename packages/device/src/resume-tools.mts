import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { sessionClientTools } from '../../protocol/src/client-tools-session.mjs'
import {
  deviceMachineEnabled,
  deviceToolSwitches,
} from '../../protocol/src/client-tools-settings.mjs'
import { TASKS_TOOLS } from '../../protocol/src/client-tools-tasks.mjs'
import { RESUME_TOOLS_CHANGED, RESUME_TOOLS_READ } from '../../protocol/src/resume-tools.mjs'
import { installSharedAutomationSkills } from '../../shared/src/automation-skills.mjs'
import { isAutomationSpec, withAutomationGuide } from '../../shared/src/automation-tools.mjs'
import { isObject } from './wire.mjs'

const refreshed = new Set<string>([
  'litch_automation',
  CLIENT_TOOL_NAMESPACE.browser,
  CLIENT_TOOL_NAMESPACE.computer,
  CLIENT_TOOL_NAMESPACE.machine,
])
type Request = (method: string, params: unknown) => Promise<unknown>

/** 外部恢复、内部恢复和重启恢复共用；同会话的读、替换、确认串行执行。 */
export class ResumeTools {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly revisions = new Map<string, { instance: string; revision: number }>()
  constructor(
    privateValues: () => Record<string, unknown> | undefined,
    privateStore: { setTools(threadId: string, tools: unknown[]): void },
    privateRestricted: (threadId: string) => boolean,
    tasksEnabled: () => boolean = () => false,
  ) {
    this.values = privateValues
    this.store = privateStore
    this.restricted = privateRestricted
    this.tasksEnabled = tasksEnabled
  }
  private readonly values: () => Record<string, unknown> | undefined
  private readonly store: { setTools(threadId: string, tools: unknown[]): void }
  private readonly restricted: (threadId: string) => boolean
  private readonly tasksEnabled: () => boolean

  supports(harness: string, native: boolean): boolean {
    return !native && (harness === 'claude-code' || harness === 'pi')
  }

  /** 恢复和经理重置共用；只更新常驻工具，角色与自定义定义保持原样。 */
  tools(harness: string, current: unknown[]): unknown[] {
    const values = this.values()
    const managedNames = new Set(refreshed)
    const manager = current.some(
      (tool) => isObject(tool) && tool.name === CLIENT_TOOL_NAMESPACE.manager,
    )
    if (manager) managedNames.add(CLIENT_TOOL_NAMESPACE.tasks)
    const managed = sessionClientTools(
      manager && this.tasksEnabled() ? [TASKS_TOOLS] : [],
      harness,
      deviceToolSwitches(values, harness),
      null,
      deviceMachineEnabled(values),
    ).filter((tool) => isObject(tool) && managedNames.has(String(tool.name)))
    if (managed.some(isAutomationSpec)) installSharedAutomationSkills()
    return withAutomationGuide([
      ...current.filter((tool) => !isObject(tool) || !managedNames.has(String(tool.name))),
      ...managed,
    ])
  }

  observe(method: string, params: unknown): void {
    if (method !== RESUME_TOOLS_CHANGED || !isObject(params)) return
    if (typeof params.threadId === 'string') this.remember(params.threadId, params, false)
  }

  private remember(id: string, snapshot: Record<string, unknown>, read: boolean): void {
    if (
      !Array.isArray(snapshot.dynamicTools) ||
      typeof snapshot.instance !== 'string' ||
      typeof snapshot.revision !== 'number'
    )
      throw new Error('工具快照缺少版本')
    const known = this.revisions.get(id)
    // 同一通知会从多个连接到达；迟到的副本和旧引擎实例不能把设备库改回去。
    if (
      known &&
      (known.instance === snapshot.instance ? known.revision >= snapshot.revision : !read)
    )
      return
    this.revisions.set(id, { instance: snapshot.instance, revision: snapshot.revision })
    this.store.setTools(id, snapshot.dynamicTools)
  }

  async resume(
    harness: string,
    params: Record<string, unknown>,
    request: Request,
    replaceTools = false,
  ): Promise<unknown> {
    const id = String(params.threadId ?? '')
    const key = `${harness}:${id}`
    const previous = this.pending.get(key)
    const work = (async () => {
      await previous?.catch(() => {})
      // 经理重置明确替换完整角色定义，也排在同一队列，不能和普通恢复互相覆盖。
      if (replaceTools) return request('thread/resume', params)
      const snapshot = await request(RESUME_TOOLS_READ, { threadId: id })
      if (!isObject(snapshot) || !Array.isArray(snapshot.dynamicTools))
        throw new Error('恢复会话时没有取得工具清单')
      this.remember(id, snapshot, true)
      // 恢复者携带的旧清单不作权威，角色和自定义工具始终取引擎的现有值。
      const { dynamicTools: _ignored, ...rest } = params
      if (
        snapshot.restricted ||
        params.ephemeral === true ||
        params.sandbox === 'read-only' ||
        params.permissions === ':read-only' ||
        (isObject(params.sandboxPolicy) && params.sandboxPolicy.type === 'readOnly') ||
        this.restricted(id)
      )
        return request('thread/resume', rest)
      const dynamicTools = this.tools(harness, snapshot.dynamicTools)
      const result = await request('thread/resume', { ...rest, dynamicTools })
      // 活动回合只记待生效；这里读取实际值，不能把尚未生效的请求写进 thread_tools。
      const applied = await request(RESUME_TOOLS_READ, { threadId: id })
      if (isObject(applied)) this.remember(id, applied, true)
      return result
    })()
    this.pending.set(key, work)
    try {
      return await work
    } finally {
      if (this.pending.get(key) === work) this.pending.delete(key)
    }
  }
}
