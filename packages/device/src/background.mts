// 设备上每个会话的后台任务（backgroundTasks 扩展，protocol/extensions/background-tasks.json）。两种来源：
//   - 适配器的引擎自己报（litch/thread/background/changed）：这里只记一份，会话树、定时任务的回报要数还有几个在跑；
//     通知本身由各条上游连接原样转给客户端，会话对象上的字段也是引擎自己带的。
//   - 原生 codex 不报，在转发层从它的条目通知里派生：回合结束时这一回合里仍 inProgress 的命令进集合，
//     命令的 item/completed 到了就结束（退出码非零记 failed），会话卸载、关闭时还在跑的记 stopped；
//     恢复会话时从历史里补，再拿 thread/backgroundTerminals/list 核一遍（原生 codex 重启之后历史里留着的
//     inProgress 命令其实早没了）。派生出来的集合由这里发通知、挂到会话对象上。
// 同一条通知会经每条订阅了这个会话的上游连接各来一份，这里的每一步都是幂等的，真的变了才发。
import {
  BACKGROUND_TASKS_NOTIFICATION,
  type BackgroundTaskStatus,
  type LitchBackground,
  type LitchBackgroundTask,
  orderBackgroundTasks,
  runningBackgroundTasks,
} from '../../protocol/src/background-tasks.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { isObject } from './wire.mjs'

export interface BackgroundHost {
  /** 发给声明了 extension 的客户端连接 */
  announce(method: string, params: unknown, extension: string): void
  now?(): number
}

interface RunningCommand {
  turnId: string
  command: string
  startedAt: number
}

export class DeviceBackground {
  private readonly host: BackgroundHost
  /** 适配器的引擎报的：会话 → 最近一份集合 */
  private readonly reported = new Map<string, LitchBackground>()
  /** 原生 codex：回合里开始了、还没结束的命令，会话 → 条目 → 命令 */
  private readonly inTurn = new Map<string, Map<string, RunningCommand>>()
  /** 原生 codex 派生出来的集合：会话 → 任务（键是命令条目的标识） */
  private readonly derived = new Map<string, Map<string, LitchBackgroundTask>>()

  constructor(host: BackgroundHost) {
    this.host = host
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  /** 适配器的引擎发来的集合变化（经哪条连接来的都一样） */
  reportedChanged(params: Record<string, unknown>): void {
    if (typeof params.threadId !== 'string' || !Array.isArray(params.tasks)) return
    this.reported.set(params.threadId, {
      tasks: params.tasks as LitchBackgroundTask[],
      wakesOnFinish: params.wakesOnFinish === true,
    })
  }

  /** 原生 codex 的一条通知 */
  codexNotification(method: string, params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    if (!threadId) return
    const item = isObject(params.item) ? params.item : null
    if (method === 'item/started' && item?.type === 'commandExecution') {
      if (typeof item.id !== 'string' || typeof params.turnId !== 'string') return
      const commands = this.inTurn.get(threadId) ?? new Map<string, RunningCommand>()
      if (commands.has(item.id)) return
      commands.set(item.id, {
        turnId: params.turnId,
        command: typeof item.command === 'string' ? item.command : '',
        startedAt: typeof params.startedAtMs === 'number' ? params.startedAtMs : this.now(),
      })
      this.inTurn.set(threadId, commands)
    } else if (method === 'item/completed' && item?.type === 'commandExecution') {
      if (typeof item.id !== 'string') return
      this.inTurn.get(threadId)?.delete(item.id)
      const task = this.derived.get(threadId)?.get(item.id)
      if (task?.status !== 'running') return
      task.status = commandStatus(item)
      task.endedAt = typeof params.completedAtMs === 'number' ? params.completedAtMs : this.now()
      this.publish(threadId)
    } else if (method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : null
      const commands = this.inTurn.get(threadId)
      if (typeof turn?.id !== 'string' || !commands) return
      let changed = false
      for (const [itemId, command] of commands) {
        if (command.turnId !== turn.id) continue
        commands.delete(itemId)
        if (this.add(threadId, itemId, command)) changed = true
      }
      if (changed) this.publish(threadId)
    } else if (
      method === 'thread/closed' ||
      (method === 'thread/status/changed' &&
        isObject(params.status) &&
        params.status.type === 'notLoaded')
    ) {
      // 卸载会带走它的后台终端
      this.inTurn.delete(threadId)
      if (this.stopAll(threadId)) this.publish(threadId)
    } else if (method === 'thread/deleted') this.forget(threadId)
  }

  /**
   * 原生 codex 的 thread/resume 应答：历史里不是最后一个进行中回合、却还 inProgress 的命令。
   * 返回要不要再拿 thread/backgroundTerminals/list 核一遍（有候选的才要）
   */
  codexResumed(thread: Record<string, unknown>): string[] {
    const threadId = typeof thread.id === 'string' ? thread.id : null
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    if (!threadId) return []
    const candidates: string[] = []
    turns.forEach((turn, index) => {
      if (!isObject(turn) || !Array.isArray(turn.items) || typeof turn.id !== 'string') return
      // 最后一个回合还在进行：它里面的命令是前台的
      if (index === turns.length - 1 && turn.status === 'inProgress') return
      for (const item of turn.items) {
        if (!isObject(item) || item.type !== 'commandExecution') continue
        if (item.status !== 'inProgress' || typeof item.id !== 'string') continue
        if (this.derived.get(threadId)?.has(item.id)) continue
        const startedAt = typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : this.now()
        const commands = this.inTurn.get(threadId) ?? new Map<string, RunningCommand>()
        commands.set(item.id, {
          turnId: turn.id,
          command: typeof item.command === 'string' ? item.command : '',
          startedAt,
        })
        this.inTurn.set(threadId, commands)
        candidates.push(item.id)
      }
    })
    return candidates
  }

  /** 恢复时补的候选核过了：listed 是 backgroundTerminals/list 里还活着的条目（问不到是 null，照历史算） */
  codexConfirmed(threadId: string, candidates: string[], listed: Set<string> | null): void {
    const commands = this.inTurn.get(threadId)
    if (!commands) return
    let changed = false
    for (const itemId of candidates) {
      const command = commands.get(itemId)
      if (!command) continue
      commands.delete(itemId)
      if ((listed === null || listed.has(itemId)) && this.add(threadId, itemId, command))
        changed = true
    }
    if (changed) this.publish(threadId)
  }

  private add(threadId: string, itemId: string, command: RunningCommand): boolean {
    const tasks = this.derived.get(threadId) ?? new Map<string, LitchBackgroundTask>()
    if (tasks.get(itemId)?.status === 'running') return false
    tasks.set(itemId, {
      id: itemId,
      kind: 'shell',
      title: command.command,
      status: 'running',
      itemId,
      turnId: command.turnId,
      startedAt: command.startedAt,
    })
    this.derived.set(threadId, tasks)
    return true
  }

  private stopAll(threadId: string): boolean {
    const tasks = this.derived.get(threadId)
    if (!tasks) return false
    let changed = false
    for (const task of tasks.values())
      if (task.status === 'running') {
        task.status = 'stopped'
        task.endedAt = this.now()
        changed = true
      }
    return changed
  }

  forget(threadId: string): void {
    this.reported.delete(threadId)
    this.inTurn.delete(threadId)
    this.derived.delete(threadId)
  }

  /** 原生 codex 派生的那一份。没有是 null */
  private derivedOf(threadId: string): LitchBackground | null {
    const tasks = this.derived.get(threadId)
    if (!tasks || tasks.size === 0) return null
    const ordered = orderBackgroundTasks(tasks.values())
    // 结束过的超了上限：多出来的不再留
    if (ordered.length < tasks.size) {
      const kept = new Set(ordered.map((task) => task.id))
      for (const id of tasks.keys()) if (!kept.has(id)) tasks.delete(id)
    }
    return { tasks: ordered, wakesOnFinish: false }
  }

  private publish(threadId: string): void {
    const background = this.derivedOf(threadId)
    if (!background) return
    this.host.announce(
      BACKGROUND_TASKS_NOTIFICATION.changed,
      { threadId, ...background },
      EXTENSION.backgroundTasks,
    )
  }

  /** 原生 codex 的会话对象经过、这条连接声明了扩展：挂上派生的集合 */
  decorate(thread: Record<string, unknown>): boolean {
    if (typeof thread.id !== 'string') return false
    const background = this.derivedOf(thread.id)
    if (!background) return false
    thread.litchBackground = structuredClone(background)
    return true
  }

  /** 这个会话还有几个后台任务在跑（会话树、定时任务的回报里写） */
  running(threadId: string): number {
    const derived = this.derivedOf(threadId)
    if (derived) return runningBackgroundTasks(derived.tasks)
    const reported = this.reported.get(threadId)
    return reported ? runningBackgroundTasks(reported.tasks) : 0
  }
}

function commandStatus(item: Record<string, unknown>): BackgroundTaskStatus {
  if (item.status === 'failed') return 'failed'
  if (item.status === 'declined') return 'stopped'
  if (typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed'
  return 'completed'
}
