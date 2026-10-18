// 设备进程的主体：一台机器上的多个 harness 运行时收在一个入口（聚合面）后面。
// 这里只管各条客户端连接共用的东西；一条连接上的事在 session.mts。
import { mkdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { EXTENSION } from '../../protocol/src/device.mjs'
import type { DeviceSettingsSnapshot } from '../../protocol/src/device-settings.mjs'
import { ClientToolInvoker } from './client-tool-invoke.mjs'
import { ClientToolRouter } from './client-tools.mjs'
import type { ControlChannel, ControlState } from './control.mjs'
import { DeviceLayer } from './device-layer.mjs'
import type { ProcessLimits } from './device-processes.mjs'
import type { FlowLimits } from './flow.mjs'
import { deviceInfo, deviceVersion, HarnessCatalog } from './harness-info.mjs'
import { WorkspaceImporter } from './importer.mjs'
import { DeviceManagement } from './management.mjs'
import { hasActiveTurn } from './probe.mjs'
import { ACTIVITY_METHOD, type DeviceActivity, serviceInfo } from './service-info.mjs'
import {
  ClientSession,
  type HarnessSource,
  type SessionHost,
  type SessionTiming,
  type UpstreamConfig,
} from './session.mjs'
import { openDeviceStore } from './store.mjs'
import { ThreadIndex } from './thread-index.mjs'
import { type Connector, isObject, type Wire, type WireHandlers } from './wire.mjs'
import { Workspaces } from './workspaces.mjs'

export interface DeviceOptions {
  /** 设备进程自己的状态目录，设备库 device.sqlite 放在里面 */
  stateDir: string
  /**
   * 设备级的工作区第一次启用时，要不要从各引擎现有的项目导入（设计文档 03 第 6.1 节）。
   * 默认要。只有测试会关：和导入无关的测试不想让设备进程自己另开连接去读上游。
   */
  importExisting?: boolean
  /** 启动时就知道的上游。有控制通道时，主进程给的名单排在前面，这里有而那边没有的排在后面 */
  upstreams: UpstreamConfig[]
  /**
   * 和适配器主进程之间的控制通道。有它才有设置功能，这台设备上全部已知的 harness（包括没起来的）
   * 和它们没起来的原因也是它给的。没有时只知道 upstreams 里的那几个，连得上就算可用。
   */
  control?: ControlChannel
  /** 按套接字地址（unix://路径）连一个运行时：主进程给的名单里、不在 upstreams 里的 harness 用它 */
  dial?(socket: string): Connector
  version?: string
  timing?: Partial<SessionTiming>
  /** 属于设备的进程（可重连的终端）的上限和期限。没给的用默认值，见 device-processes.mts */
  processes?: Partial<ProcessLimits>
  /** 进程输出的流量控制看发送积压的两条线。只有测试会改 */
  flow?: Partial<FlowLimits>
  /** 运行日志：连接的建立与断开、harness 的可用状态变化。不给就不记 */
  log?(line: string): void
}

const DEFAULT_TIMING: SessionTiming = {
  retryMs: [500, 1000, 2000, 5000],
  handshakeTimeoutMs: 10_000,
  settleMs: 3000,
  // Pi 每次列表都要扫描原生会话目录，dsh 每次都要问一遍它的后台进程，给得宽一些
  listTimeoutMs: 60_000,
  probeTimeoutMs: 15_000,
  // 和客户端等一个请求的默认时限（packages/core 的 rpc.mts，30 秒）一样长：
  // 再久，发起新建的那一头自己都已经不等了
  startedHoldMs: 30_000,
  // 原生 codex 发给各条连接的几份客户端工具调用前后只差几毫秒，见 client-tools.mts
  clientToolGraceMs: 50,
}

export class DeviceServer {
  private readonly host: SessionHost
  private readonly sessions = new Set<ClientSession>()
  private readonly db: DatabaseSync
  private readonly index: ThreadIndex
  private readonly workspaces: Workspaces
  private readonly importer: WorkspaceImporter | null
  private readonly layer: DeviceLayer
  private readonly options: DeviceOptions
  private readonly control: ControlChannel | null
  private readonly version: string
  /** 主进程给的名单里的 harness 怎么连，按套接字地址记着 */
  private readonly dialed = new Map<string, Connector>()
  /** 上一次发给客户端的设置快照（起步时是主进程给的第一份现状），用来判断是不是真的变了 */
  private lastSnapshot: string | null = null
  /** 有几次写入正在进行。大于 0 时设置变化的通知先攒着，见 holdSettings */
  private settling = 0
  /** 还没告诉客户端的那些变化动过的设置键 */
  private readonly unannounced = new Set<string>()
  private closed = false

  constructor(options: DeviceOptions) {
    mkdirSync(options.stateDir, { recursive: true, mode: 0o700 })
    this.options = options
    this.control = options.control ?? null
    this.version = options.version ?? deviceVersion()
    this.db = openDeviceStore(options.stateDir)
    // 先建索引（它把上一次留下的临时会话清掉），再建工作区
    this.index = new ThreadIndex(this.db)
    this.workspaces = new Workspaces(this.db, (method, params, extension) =>
      this.announce(method, params, extension),
    )
    const info = deviceInfo(this.version)
    // 设置功能要有适配器主进程在管才有：客户端看这份列表决定出不出设置界面
    if (this.control) info.extensions.push(EXTENSION.deviceSettings)
    // 服务的来历也是主进程给的：有它在管，声明过的客户端才问得到“在跑的是哪一份”
    if (this.control) info.extensions.push(EXTENSION.deviceService)
    // 可重连的终端：进程可以属于设备
    info.extensions.push(EXTENSION.deviceProcesses)
    const log = options.log ?? (() => {})
    this.layer = new DeviceLayer({
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.flow ? { flow: options.flow } : {}),
      // 设备上这类进程多了少了，告诉所有声明过这项扩展的连接：别的窗口的终端列表跟着变
      announce: (method, params, extension) => this.announce(method, params, extension),
      log,
    })
    if (this.control) {
      // 已经到了的那一份是现状，之后和它不一样才算变化
      if (this.control.state) {
        this.lastSnapshot = JSON.stringify(this.control.state.snapshot)
        this.applyProcessLimits(this.control.state)
      }
      this.control.onState = (state) => this.controlChanged(state)
      this.control.onAsk = (method) => this.asked(method)
    }
    const router = new ClientToolRouter({
      graceMs: options.timing?.clientToolGraceMs ?? DEFAULT_TIMING.clientToolGraceMs,
      log,
    })
    this.host = {
      harnesses: () => this.harnesses(),
      management: new DeviceManagement({
        control: this.control,
        busy: (harness) => this.busy(harness),
        settling: () => this.holdSettings(),
        log,
      }),
      stateDir: options.stateDir,
      info,
      service: () => serviceInfo(this.control?.state ?? null),
      index: this.index,
      workspaces: this.workspaces,
      catalog: new HarnessCatalog(),
      layer: this.layer,
      timing: { ...DEFAULT_TIMING, ...options.timing },
      log,
      closed: (session) => this.sessions.delete(session),
      clientTools: router,
      clientInvoke: new ClientToolInvoker({ router, index: this.index, log }),
      reachable: () => this.importer?.kick(),
      importing: () => {
        this.importer?.kick()
        return this.importer?.idle() ?? Promise.resolve()
      },
    }
    this.importer =
      options.importExisting === false
        ? null
        : new WorkspaceImporter({
            db: this.db,
            index: this.index,
            workspaces: this.workspaces,
            harnesses: () => this.harnesses(),
            version: this.version,
            timeoutMs: this.host.timing.listTimeoutMs,
            log,
          })
    // 运行时已经在跑的话现在就导入，不等第一个客户端连进来
    this.importer?.kick()
  }

  /**
   * 设备层的数据变了：告诉所有聚合面连接（设计文档 03 第 5.4 节），发起变更的那条也收，和引擎里的做法一样。
   * 变更都是在处理某个请求的时候发生的，通知排到那个请求的应答后面再发。
   * 发给谁按变更发生的这一刻算：这之后才握手完成的连接，握手之后读到的已经是变更后的，不用再通知
   * （第一次导入时会有成百上千条，不该追着刚连上的客户端发）。
   */
  private announce(method: string, params: unknown, extension?: string): void {
    const audience = [...this.sessions].filter((session) => session.ready)
    if (audience.length === 0) return
    setImmediate(() => {
      for (const session of audience) session.announce(method, params, extension)
    })
  }

  /** 这台设备上现在已知的全部 harness */
  private harnesses(): HarnessSource[] {
    const sources: HarnessSource[] = []
    const seen = new Set<string>()
    for (const managed of this.control?.state?.harnesses ?? []) {
      const configured = this.options.upstreams.find((upstream) => upstream.id === managed.id)
      sources.push({
        id: managed.id,
        connect: configured?.connect ?? this.dial(managed.socket),
        managed,
      })
      seen.add(managed.id)
    }
    for (const upstream of this.options.upstreams)
      if (!seen.has(upstream.id)) sources.push({ ...upstream, managed: null })
    return sources
  }

  private dial(socket: string): Connector {
    let connect = this.dialed.get(socket)
    if (!connect) {
      connect =
        this.options.dial?.(socket) ?? (() => Promise.reject(new Error(`不知道怎么连 ${socket}`)))
      this.dialed.set(socket, connect)
    }
    return connect
  }

  /** 主进程推来了新的状态：各条连接跟着调整上游，设置真的变了就通知声明过的客户端 */
  private controlChanged(state: ControlState): void {
    this.applyProcessLimits(state)
    for (const session of this.sessions) session.sync()
    // 刚起来的 harness，它现有的项目还没导入过的话现在去读
    this.importer?.kick()
    for (const key of state.keys) this.unannounced.add(key)
    // 有写入正在进行：这一条多半是途中的样子，等写入有了结果再说
    if (this.settling === 0) this.announceSettings()
  }

  /** 设置的现状和上一次告诉客户端的不一样，或者有改了的键还没说：发一条通知 */
  private announceSettings(): void {
    const state = this.control?.state
    if (!state) return
    const snapshot = JSON.stringify(state.snapshot)
    const first = this.lastSnapshot === null
    const same = snapshot === this.lastSnapshot
    this.lastSnapshot = snapshot
    const keys = [...this.unannounced]
    this.unannounced.clear()
    // 第一条是连上时的现状，不算变化
    if (keys.length === 0 && (first || same)) return
    for (const session of this.sessions) session.settingsChanged({ keys, snapshot: state.snapshot })
  }

  /**
   * 一次写入开始了，设置变化的通知先攒着。写入途中主进程推来的现状是一步一步的：先把 harness 标成待重启，
   * 重新应用时摘掉，它的 SSH 入口没了又回来——这些转眼就作废，发出去只会让界面跟着闪。
   * 返回的函数在写入有了结果时调用：攒着的并成一条发出去（在写入的应答之前），返回这时候的现状。
   * harness 自己的状态变化（litch/harness/status/changed）不归这里管，照常当时就发。
   * 两次写入叠在一起时等后一次也有了结果才发，先结束的那一次拿到的现状里可能带着另一次途中的样子。
   */
  private holdSettings(): () => DeviceSettingsSnapshot | null {
    this.settling++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.settling--
        if (this.settling === 0 && !this.closed) this.announceSettings()
      }
      return this.control?.state?.snapshot ?? null
    }
  }

  /** 可重连的终端的上限和期限跟着设置走：不重启设备进程，当场换，只管之后的事 */
  private applyProcessLimits(state: ControlState): void {
    if (isObject(state.processes)) this.layer.deviceProcesses.setLimits(state.processes)
  }

  /** 这个 harness 是不是有回合在跑。判断不了的时候返回 true（设计文档 03 第十三节） */
  private async busy(harness: string): Promise<boolean> {
    const source = this.harnesses().find((item) => item.id === harness)
    if (!source?.managed) return true
    // 运行时没在跑，也就没有回合
    if (source.managed.state !== 'running') return false
    return hasActiveTurn(source.connect, this.host.timing.probeTimeoutMs, this.version)
  }

  /** 主进程经控制通道来问一件事。现在只有一件：忙不忙 */
  private asked(method: string): Promise<unknown> {
    if (method === ACTIVITY_METHOD) return this.activity()
    return Promise.reject(new Error(`不认识 ${method}`))
  }

  /**
   * 这台设备现在忙不忙（device-stop --if-idle 停服务之前要看）：哪些 harness 有回合在跑、
   * 有几个属于设备的终端在跑、聚合面上连着几个客户端。回合去问每个在跑的运行时，几个一起问；
   * 问不出来的按有算。连接开的终端随连接走，有连接在就已经算忙，不另数。
   */
  private async activity(): Promise<DeviceActivity> {
    const running = this.harnesses().filter((source) => source.managed?.state === 'running')
    const busy = await Promise.all(running.map((source) => this.busy(source.id)))
    return {
      turns: running.filter((_, index) => busy[index]).map((source) => source.id),
      processes: this.layer.deviceProcesses.running,
      connections: this.sessions.size,
    }
  }

  /** 聚合面上进来了一条客户端连接。返回值接在这条连接的接收端上 */
  attach(wire: Wire): WireHandlers {
    const session = new ClientSession(this.host, wire)
    this.sessions.add(session)
    return {
      message: (text) => session.receive(text),
      close: () => session.close(),
    }
  }

  get connections(): number {
    return this.sessions.size
  }

  /** 设备层现在还活着的进程数（各条连接开的终端和命令，加上属于设备的进程） */
  get processes(): number {
    return this.layer.processes.activeCount
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.control) {
      this.control.onState = null
      this.control.onAsk = null
    }
    for (const session of [...this.sessions]) session.close()
    await this.importer?.close()
    await this.layer.close()
    this.db.close()
  }
}
