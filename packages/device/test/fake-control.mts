// 进程内的假控制通道：扮演适配器主进程（Go 层）那一头。记着每个 harness 的状态和一份设置快照，
// 按控制协议应答，状态变了就推给设备进程。应答可以由测试改。
import type {
  DeviceSettingsSnapshot,
  ManagedHarnessState,
} from '../../protocol/src/device-settings.mjs'
import {
  type ControlChannel,
  ControlFailure,
  type ControlFailureDetail,
  type ControlState,
  type ManagedHarness,
} from '../src/control.mjs'
import type { ProcessLimits } from '../src/device-processes.mjs'

const TEXT: Partial<Record<ManagedHarnessState, { 'zh-CN': string; en: string }>> = {
  disabled: { 'zh-CN': '已在设置里停用', en: 'Turned off in settings' },
  notInstalled: { 'zh-CN': '没有找到它的命令行', en: 'Its CLI was not found' },
  versionTooLow: { 'zh-CN': '版本太低', en: 'The version is too old' },
  startFailed: { 'zh-CN': '没能启动', en: 'It failed to start' },
  stopped: { 'zh-CN': '已经停止', en: 'It has stopped' },
  starting: { 'zh-CN': '正在启动', en: 'Starting' },
}

/** 按主进程的写法给一个 harness 的状态。运行时的套接字用标识代替，测试里按它找假上游 */
export function managed(id: string, state: ManagedHarnessState = 'running'): ManagedHarness {
  return { id, socket: `fake://${id}`, state, text: TEXT[state] ?? null }
}

export const failure = (detail: Partial<ControlFailureDetail>): ControlFailure =>
  new ControlFailure({ reason: 'failed', text: { 'zh-CN': '没做成', en: 'It failed' }, ...detail })

export class FakeControl implements ControlChannel {
  state: ControlState | null = null
  onState: ((state: ControlState) => void) | null = null
  onAsk: ((method: string) => Promise<unknown>) | null = null
  onInstall: ((job: unknown) => void) | null = null
  /** 主进程报的自己的来历。不给就像没有报 */
  service: ControlState['service'] | null = null
  /** 设备进程发来过的请求，按到达顺序 */
  readonly requests: { method: string; params: any }[] = []
  /** 测试可以盖掉默认的应答 */
  readonly handlers: Record<string, (params: any) => unknown>
  /** 下一次写入之后，这些 harness 变成待重启 */
  nextPending: string[] = []
  /** 重新应用之后那个 harness 变成什么状态 */
  applyTo: ManagedHarnessState = 'running'
  private harnesses: ManagedHarness[]
  /** 可重连的终端现行的上限和期限。没给过就不带，设备进程用它启动时的那一份 */
  private processes: Partial<ProcessLimits> | null = null
  /** 定时任务的两项设置。null：主进程没推（旧版） */
  tasks: { enabled?: boolean; maxConcurrent?: number } | null = null
  private snapshot: DeviceSettingsSnapshot = {
    version: 0,
    values: {},
    explicit: [],
    pendingRestart: [],
    sshEntries: [],
  }

  /** announce 为 false 时先不给状态，像设备进程刚起来、主进程的第一条状态还没到的时候 */
  constructor(harnesses: ManagedHarness[], announce = true) {
    this.harnesses = harnesses
    this.handlers = {
      'settings.read': () => ({
        schema: { groups: [], settings: [] },
        snapshot: this.snapshot,
        inheritedEnv: [],
      }),
      'settings.write': (params) => {
        if (params.expectedVersion !== this.snapshot.version)
          throw failure({ reason: 'conflict', snapshot: this.snapshot })
        const changed = params.edits.map((edit: { key: string }) => edit.key)
        const fresh = this.nextPending.filter((id) => !this.snapshot.pendingRestart.includes(id))
        this.snapshot = {
          ...this.snapshot,
          version: this.snapshot.version + 1,
          explicit: [...new Set([...this.snapshot.explicit, ...changed])],
          pendingRestart: [...this.snapshot.pendingRestart, ...fresh],
        }
        this.nextPending = []
        this.push(changed)
        return { changed, newlyPending: fresh, snapshot: this.snapshot }
      },
      'harness.apply': (params) => {
        const target = this.harnesses.find((item) => item.id === params.harness)
        if (!target) throw failure({ reason: 'unknownHarness', harness: params.harness })
        this.snapshot = {
          ...this.snapshot,
          pendingRestart: this.snapshot.pendingRestart.filter((id) => id !== params.harness),
        }
        this.set(params.harness, this.applyTo)
        const current = managed(params.harness, this.applyTo)
        return {
          harness: params.harness,
          state: current.state,
          text: current.text,
          snapshot: this.snapshot,
        }
      },
      'diagnostics.run': (params) => ({
        ranAt: '2026-10-13T00:00:00Z',
        checks: [
          {
            id: 'runtime',
            scope: { kind: 'harness', harness: params.harness ?? 'pi' },
            status: 'ok',
            title: { 'zh-CN': '引擎的命令行和运行环境', en: 'Engine CLI and runtime environment' },
            detail: null,
            logPath: null,
          },
        ],
      }),
      'logs.tail': (params) => ({
        path: `/fake/${params.source}.log`,
        text: `${params.source} ${params.harness ?? ''} ${params.maxBytes ?? ''}`,
        truncated: false,
        size: 3,
      }),
      'ssh.config': () => ({ entries: [], text: '' }),
    }
    if (announce) this.push()
  }

  /** 主进程推一条新的状态 */
  push(keys: string[] = []): void {
    this.state = {
      keys,
      harnesses: this.harnesses,
      snapshot: this.snapshot,
      ...(this.processes ? { processes: this.processes } : {}),
      ...(this.tasks ? { tasks: this.tasks } : {}),
      ...(this.service ? { service: this.service } : {}),
    }
    this.onState?.(this.state)
  }

  /** 设置里定时任务那一组改了：主进程把现行值推过来 */
  taskSettings(tasks: { enabled?: boolean; maxConcurrent?: number }): void {
    this.tasks = { ...this.tasks, ...tasks }
    this.push(Object.keys(tasks).map((key) => `tasks.${key}`))
  }

  /** 主进程问设备进程一件事。没有人接、答不上都会抛出来 */
  ask(method: string): Promise<unknown> {
    if (!this.onAsk) return Promise.reject(new Error('没有人接'))
    return this.onAsk(method)
  }

  /** 设置里可重连的终端那一组改了：主进程把现行的上限和期限推过来 */
  limit(processes: Partial<ProcessLimits>): void {
    this.processes = { ...this.processes, ...processes }
    this.push(Object.keys(processes).map((key) => `processes.${key}`))
  }

  /** 一个 harness 的状态变了 */
  set(id: string, state: ManagedHarnessState): void {
    // 是不是原生的 codex 不随状态变
    this.harnesses = this.harnesses.map((item) =>
      item.id === id ? { ...managed(id, state), ...(item.native ? { native: true } : {}) } : item,
    )
    this.push()
  }

  /** 快照里设置之外的东西变了（待重启的名单、SSH 入口的状况） */
  patch(change: Partial<DeviceSettingsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    this.push()
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    const handler = this.handlers[method]
    if (!handler) return Promise.reject(failure({}))
    // 真的通道上应答总是晚一拍才到
    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          resolve(handler(params ?? {}))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  /** 设备进程发来过的某种请求 */
  sent(method: string): any[] {
    return this.requests.filter((item) => item.method === method).map((item) => item.params)
  }

  close(): void {}
}
