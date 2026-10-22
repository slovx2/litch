// 聚合面上的一条客户端连接：握手、路由、它专属的那一组上游连接。
import { randomUUID } from 'node:crypto'
import { BACKGROUND_TASKS_NOTIFICATION } from '../../protocol/src/background-tasks.mjs'
import {
  CLIENT_TOOL_METHOD,
  CLIENT_TOOLS_CAPABILITY,
  type ClientToolsDesktopInfo,
} from '../../protocol/src/client-tools.mjs'
import {
  type DeviceInfo,
  type DeviceRuntimeInfo,
  EXTENSION,
  EXTENSIONS_CAPABILITY,
  HARNESS_STATUS_CHANGED,
  type HarnessInfo,
  type HarnessUnavailable,
} from '../../protocol/src/device.mjs'
import { DEVICE_PAIR_ERROR } from '../../protocol/src/device-pairing.mjs'
import {
  DEVICE_SETTINGS_CHANGED,
  type DeviceSettingsChangedNotification,
} from '../../protocol/src/device-settings.mjs'
import type { HarnessConfigChangedNotification } from '../../protocol/src/harness-config.mjs'
import { localTaskTimeZone } from '../../protocol/src/task-schedule.mjs'
import { clientToolNamespaces } from '../../shared/src/client-tool-executor.mjs'
import { errorText, idFields } from '../../shared/src/log-file.mjs'
import { ProtocolError, requiredString } from '../../shared/src/protocol-contract.mjs'
import {
  CODEX_PROTOCOL_VERSION,
  codexUserAgent,
  platformFamily,
  platformOs,
} from '../../shared/src/runtime-version.mjs'
import type { DeviceBackground } from './background.mjs'
import type { ClientToolInvoker } from './client-tool-invoke.mjs'
import type { ClientToolPeer, ClientToolRouter } from './client-tools.mjs'
import type { CodexTitles } from './codex-titles.mjs'
import type { ManagedHarness } from './control.mjs'
import type { DeviceTrace } from './device.mjs'
import { DeviceCalls, type DeviceLayer } from './device-layer.mjs'
import { type DeviceTools, declareDeviceTools } from './device-tools.mjs'
import {
  HarnessConfigError,
  type HarnessConfigTranslator,
  INSTRUCTIONS_METHODS,
  isHarnessConfigMethod,
  text,
} from './harness-config.mjs'
import { describeHarness, type HarnessCatalog, REQUIRED_EXTENSIONS } from './harness-info.mjs'
import { instructionsCall } from './instructions.mjs'
import { listThreads } from './list-threads.mjs'
import { type DeviceManagement, MANAGEMENT_PREFIX } from './management.mjs'
import { dialectFor, NATIVE_CODEX_DIALECT } from './native-codex.mjs'
import { type DevicePairing, PAIR_PREFIX, PairingError } from './pairing.mjs'
import { Relay } from './relay.mjs'
import { classify } from './routes.mjs'
import { describeDevice } from './service-info.mjs'
import { sessionTreeCall } from './session-methods.mjs'
import type { SessionTree } from './session-tree.mjs'
import { DEVICE_TASK_PREFIX, type DeviceTasks } from './tasks.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { type ForwardedRequest, INTERNAL_ID_PREFIX, UpstreamLink } from './upstream.mjs'
import {
  type Connector,
  DeviceError,
  type Frame,
  idKey,
  isObject,
  type RpcId,
  toRpcError,
  UpstreamRpcError,
  type Wire,
} from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'

export interface UpstreamConfig {
  id: string
  connect: Connector
  /** 这个运行时是原生的 codex，不是适配器（native-codex.mts）。有适配器主进程管着时以它说的为准 */
  native?: boolean
}

export interface SessionTiming {
  retryMs: number[]
  handshakeTimeoutMs: number
  /** 握手应答最多等上游多久。到点还没连上的 harness 先报成不可用，连上了再发通知 */
  settleMs: number
  listTimeoutMs: number
  probeTimeoutMs: number
  /**
   * 带工作区的新建（或分叉）等上游应答的工夫里，这个上游的会话开始通知最多扣多久。
   * 到点还没等到应答就放出去，不再扣（见 relay.mts）。
   */
  startedHoldMs: number
  /** 原生 codex 的客户端工具调用挑不出执行方时，等其余几份到齐的工夫（毫秒），见 client-tools.mts */
  clientToolGraceMs: number
  /** 子会话里的审批、提问挂了这么久没人答，算它停下来在等用户（session-tree.mts） */
  needsUserMs: number
  /** 会话树的连接订阅着、又用不着了的会话，隔这么久退订（session-tree.mts 的 releaseLater） */
  releaseMs: number
}

/** 这台设备上的一个 harness：怎么连它的运行时，以及适配器主进程眼里它的状态 */
export interface HarnessSource extends UpstreamConfig {
  /** null：没有主进程告诉我们它起没起来，只能自己去连了看 */
  managed: ManagedHarness | null
}

/** 设备进程里各条连接共用的东西 */
export interface SessionHost {
  /** 这台设备上现在已知的全部 harness，顺序就是对外报告的顺序。名单和状态会变 */
  harnesses(): HarnessSource[]
  /** 设备配置接口（设置、重启、诊断、日志） */
  management: DeviceManagement
  stateDir: string
  info: DeviceInfo
  /** 正在运行的那份适配器服务的来历（service-info.mts）。没有主进程在管、它没报，都是 null */
  service(): DeviceInfo['service'] | null
  index: ThreadIndex
  /** 设备级的工作区、会话归属、分区与置顶 */
  workspaces: Workspaces
  catalog: HarnessCatalog
  layer: DeviceLayer
  timing: SessionTiming
  /** 运行日志 */
  log(line: string): void
  /** 结构化的摘要（logs/device.jsonl）。没有就不记 */
  trace?: DeviceTrace
  closed(session: ClientSession): void
  /** 这条连接连上了一个 harness 的运行时：它现有的项目还没导入过的话，现在可以去读了 */
  reachable(harness: string): void
  /** 正在进行的那一次“从引擎导入现有的项目”结束。没有在导入就立刻结束 */
  importing(): Promise<void>
  /** 原生 codex 的客户端工具调用由这里挑执行方（各连接共用） */
  clientTools: ClientToolRouter
  /** 命令行经聚合面发来的客户端工具调用（litch/clientTool/invoke），由这里转给一台 Litch */
  clientInvoke: ClientToolInvoker
  /** 定时任务（deviceTasks 扩展）。任务库打不开时是 null，设备上就没有这项扩展 */
  tasks: DeviceTasks | null
  /** 由设备进程自己执行的 litch_ 命名空间：替每条上游连接声明，调用落到哪条上就在那里拦（device-tools.mts） */
  deviceTools: DeviceTools
  /** 会话树（session-tree.mts） */
  sessionTree: SessionTree
  /** 设置里“会话编排”开着 */
  sessionTreeOn(): boolean
  /** 扫码绑定手机（devicePairing）。设备进程没给配置时是 null */
  pairing: DevicePairing | null
  /** harness 详情设置经设备进程的翻译改了配置：告诉所有声明过 harnessConfig 的连接 */
  harnessConfigChanged(params: HarnessConfigChangedNotification): void
  /** 设备设置里 `harness.<id>.env` 填了哪些变量名。没有设置功能时是空的 */
  harnessEnvNames(harness: string): string[]
  /** 原生 codex 自带的模型目录（主进程跑 `codex debug models --bundled`，控制命令 codex.models）。没有主进程时抛错 */
  codexCatalog(): Promise<unknown>
  /** 原生 codex 会话的自动起名（codex-titles.mts） */
  titles: CodexTitles
  /** 每个会话的后台任务（background.mts，各连接共用） */
  background: DeviceBackground
}

/** 请求已经有着落：转给上游了（应答由上游来），或者已经自己答过了 */
const HANDLED = Symbol('handled')

/** `thread/metadata/update` 里归设备层管、不带给引擎的字段（isPinned 不在协议里，是适配器的引擎多认的） */
const DEVICE_METADATA = new Set(['harness', 'projectId', 'isPinned'])

/** 握手时 Litch 报的“我是哪台桌面端”。没报、形状不对是 null */
function desktopOf(capabilities: Record<string, unknown>): ClientToolsDesktopInfo | null {
  const declared = capabilities[CLIENT_TOOLS_CAPABILITY]
  const desktop = isObject(declared) ? declared.desktop : null
  if (!isObject(desktop) || typeof desktop.hostname !== 'string' || !desktop.hostname) return null
  return {
    hostname: desktop.hostname,
    ...(typeof desktop.name === 'string' && desktop.name ? { name: desktop.name } : {}),
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

export class ClientSession implements ClientToolPeer {
  readonly id = randomUUID()
  private readonly host: SessionHost
  private readonly wire: Wire
  private readonly links = new Map<string, UpstreamLink>()
  private readonly relay: Relay
  private readonly calls: DeviceCalls
  private state: 'new' | 'initializing' | 'ready' | 'closed' = 'new'
  /** 握手应答发出去之前，要发给客户端的帧先攒在这里 */
  private gate: string[] | null = []
  private optOut = new Set<string>()
  /** 客户端握手时声明认识的扩展 */
  private declared = new Set<string>()
  /** 握手时客户端给的参数，之后才出现的 harness 也用它去握手 */
  private initializeParams: unknown = null
  /** 握手时声明能执行的客户端工具命名空间（clientTools 扩展） */
  clientToolNamespaces: ReadonlySet<string> = new Set()
  /** 握手时报的桌面端信息（声明了 litch_machine 的 Litch 带） */
  desktop: ClientToolsDesktopInfo | null = null
  /** 每个 harness 上一次报给客户端的声明，用来判断状态是不是真的变了 */
  private readonly announced = new Map<string, string>()
  private readonly probes = new Map<string, Promise<string | null>>()
  /** 替不认识 litch/harness/* 的上游（原生 codex）答这些方法的翻译器，每个 harness 一个，用到才建 */
  private readonly translators = new Map<string, HarnessConfigTranslator>()
  /** 记摘要用：客户端发来、还没应答的请求（键是请求号），见 traced */
  private readonly started = new Map<string, { method: string; at: number; ids: object }>()

  constructor(host: SessionHost, wire: Wire) {
    this.host = host
    this.wire = wire
    this.relay = new Relay({
      send: (text) => this.send(text),
      optedOut: (method) => this.optOut.has(method),
      declares: (extension) => this.declared.has(extension),
      index: host.index,
      workspaces: host.workspaces,
      startedHoldMs: host.timing.startedHoldMs,
      log: (line) => host.log(`${this.tag} ${line}`),
      answered: (link, id, error) => this.traced(id, error, link.harness),
      deviceTools: host.deviceTools,
      observe: (link, method, params) =>
        this.translators.get(link.harness)?.notification(method, params),
      sessions: {
        clientTurn: (harness, turnId) => host.sessionTree.clientTurn(harness, turnId),
        turnEvent: (harness, method, params) => {
          host.sessionTree.turnEvent(harness, method, params)
          host.titles.turnEvent(method, params)
        },
        decorate: (thread) => host.sessionTree.decorate(thread),
      },
      background: {
        notification: (link, method, params) => {
          if (method === BACKGROUND_TASKS_NOTIFICATION.changed)
            host.background.reportedChanged(params)
          else if (link.dialect.clientToolsByDevice)
            host.background.codexNotification(method, params)
        },
        decorate: (thread) => {
          host.background.decorate(thread)
        },
        resumed: (link, thread) => {
          if (!link.dialect.clientToolsByDevice) return
          const candidates = host.background.codexResumed(thread)
          if (candidates.length === 0) return
          const threadId = String(thread.id)
          // 原生 codex 重启过的话历史里的 inProgress 命令早没了：拿后台终端的列表核一遍，问不到就照历史算
          link
            .request('thread/backgroundTerminals/list', { threadId }, host.timing.probeTimeoutMs)
            .then(
              (result) =>
                isObject(result) && Array.isArray(result.data)
                  ? new Set(
                      result.data.flatMap((entry) =>
                        isObject(entry) && typeof entry.itemId === 'string' ? [entry.itemId] : [],
                      ),
                    )
                  : null,
              () => null,
            )
            .then((listed) => host.background.codexConfirmed(threadId, candidates, listed))
        },
      },
      clientTools: {
        offer: (link, frame, upstreamId) => host.clientTools.offer(this, link, frame, upstreamId),
        resolved: (link, requestId) => host.clientTools.resolved(link, requestId),
        subscribed: (link, threadId) => host.clientTools.subscribed(this, link.harness, threadId),
        turnStarted: (link, turnId) => host.clientTools.turnStarted(this, link.harness, turnId),
        turnBegan: (link, threadId, turnId) =>
          host.clientTools.turnBegan(link.harness, threadId, turnId),
        turnEnded: (link, turnId) => host.clientTools.turnEnded(link.harness, turnId),
      },
    })
    // 设备层（终端输出、文件变化、找文件的结果）经它把通知发回这条连接
    this.calls = new DeviceCalls(host.layer, {
      id: this.id,
      send: (message, flushed) => {
        if ('method' in message && this.optOut.has(message.method)) return
        this.send(JSON.stringify(message), flushed)
      },
      close: () => this.wire.close(),
      declares: (extension) => this.declared.has(extension),
      // 进程输出的流量控制看的是这条连接的发送积压
      backlog: () => this.wire.backlog?.() ?? 0,
    })
  }

  /** 客户端发来的一帧 */
  receive(raw: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      this.wire.send(JSON.stringify({ id: null, error: { code: -32700, message: 'Parse error' } }))
      return
    }
    if (!isObject(frame)) return
    if (typeof frame.method === 'string') {
      // 客户端的通知只有 initialized；和上游的握手是设备进程自己做的，不用转
      if (frame.id != null) this.request(frame.id as RpcId, frame.method, frame as Frame, raw)
    } else if (frame.id != null) this.relay.answer(frame as Frame, raw)
  }

  /** 客户端断开：这一组上游连接一起断，它开的终端和文件监听一起清掉 */
  close(): void {
    if (this.state === 'closed') return
    const greeted = this.state === 'ready'
    this.state = 'closed'
    for (const link of this.links.values()) link.stop()
    for (const translator of this.translators.values()) translator.close()
    this.translators.clear()
    this.relay.close()
    this.calls.close()
    this.host.clientTools.left(this)
    this.host.clientInvoke.callerLeft(this)
    this.host.clientInvoke.peerLeft(this)
    this.host.closed(this)
    if (greeted) this.host.log(`${this.tag} 断开`)
    this.host.trace?.('peer.close', {
      conn: this.id.slice(0, 8),
      ...(this.started.size ? { unanswered: this.started.size } : {}),
    })
    this.started.clear()
  }

  /**
   * 一个客户端请求有了结果：记一条摘要（方法、连接、请求号、标识字段、成败、耗时、错误原文）。
   * 转发给上游的由 Relay 在应答回来时调（harness 是转去的那个）；设备进程自己答的在 request 里调
   */
  private traced(id: RpcId, error: unknown, harness?: string): void {
    const trace = this.host.trace
    if (!trace) return
    const key = idKey(id)
    const entry = this.started.get(key)
    if (!entry) return
    this.started.delete(key)
    const failed = error !== null && error !== undefined
    trace(
      'rpc',
      {
        method: entry.method,
        conn: this.id.slice(0, 8),
        id,
        ...(harness ? { harness } : {}),
        ...entry.ids,
        ok: !failed,
        ms: Date.now() - entry.at,
        ...(failed ? { error: errorText(error) } : {}),
      },
      failed ? 'warn' : 'info',
    )
  }

  deliverClientTool(harness: string, frame: Frame, onAnswer: (reply: Frame) => void): RpcId {
    return this.relay.deliver(harness, frame, onAnswer)
  }

  withdrawClientTool(facingId: RpcId, threadId: string | null): void {
    this.relay.withdraw(facingId, threadId)
  }

  /** 这个 harness 发来的这条请求（上游的请求号）是不是转给了这条连接的客户端、还在等它答 */
  holdsServerRequest(harness: string, requestId: RpcId): boolean {
    return this.state !== 'closed' && this.relay.holds(harness, requestId)
  }

  upstream(harness: string): UpstreamLink | null {
    return this.links.get(harness) ?? null
  }

  /** 日志里认这条连接用的短名字 */
  private get tag(): string {
    return `连接 ${this.id.slice(0, 8)}`
  }

  /** detail：系统给的原文（里面有套接字的路径），只写在日志里，不给客户端 */
  private note(info: HarnessInfo, detail: string | null): void {
    const state = info.unavailable
      ? `不可用（${info.unavailable.kind}）：${info.unavailable.message}${detail ? `｜${detail}` : ''}`
      : `可用${info.version ? `，版本 ${info.version}` : ''}`
    this.host.log(`${this.tag} ${info.id} ${state}`)
  }

  /** flushed：这一帧已经交给系统了（握手完成之前攒着的帧不带它，那时候还没有进程的输出） */
  private send(text: string, flushed?: () => void): void {
    if (this.state === 'closed') return
    if (this.gate) this.gate.push(text)
    else this.wire.send(text, flushed)
  }

  private request(id: RpcId, method: string, frame: Frame, raw: string): void {
    if (this.host.trace)
      this.started.set(idKey(id), { method, at: Date.now(), ids: idFields(frame.params) })
    const fail = (error: unknown) => {
      this.traced(id, error)
      if (this.state !== 'closed') this.wire.send(JSON.stringify({ id, error: toRpcError(error) }))
    }
    let outcome: unknown
    try {
      outcome = this.dispatch(id, method, frame, raw)
    } catch (error) {
      fail(error)
      return
    }
    // 能立刻转发的请求在上面已经同步发走了，先后顺序和客户端发来的一致
    if (outcome === HANDLED) return
    Promise.resolve(outcome).then((result) => {
      if (result === HANDLED) return
      this.traced(id, null)
      if (this.state !== 'closed') this.wire.send(JSON.stringify({ id, result: result ?? {} }))
    }, fail)
  }

  private dispatch(id: RpcId, method: string, frame: Frame, raw: string): unknown {
    if (method === 'initialize') return this.initialize(id, frame.params)
    // 命令行（litch-machine）的两个方法不用握手：握手要为它连一遍每个 harness 的运行时
    if (method === CLIENT_TOOL_METHOD.desktops && this.state !== 'closed')
      return this.host.clientInvoke.desktops()
    if (method === CLIENT_TOOL_METHOD.invoke && this.state !== 'closed')
      return this.host.clientInvoke.invoke(this, frame.params).then((outcome) => {
        if ('error' in outcome) throw new UpstreamRpcError(outcome.error)
        return outcome.result
      })
    // 扫码绑定手机的方法也不用握手：设备上的命令行 pair、pair-enroll 直接连 device.sock 调
    if (method.startsWith(PAIR_PREFIX) && this.state !== 'closed') {
      if (!this.host.pairing)
        throw new PairingError(DEVICE_PAIR_ERROR.unsupported, '这台设备不支持扫码绑定手机')
      return this.host.pairing.call(method, frame.params)
    }
    if (this.state !== 'ready') throw new ProtocolError(-32600, 'Not initialized')
    if (typeof id === 'string' && id.startsWith(INTERNAL_ID_PREFIX))
      throw new ProtocolError(-32600, `请求号不能以 ${INTERNAL_ID_PREFIX} 开头`)
    const route = classify(method, frame.params)
    switch (route.kind) {
      case 'device':
        if (method === 'runtime/info') return this.runtimeInfo()
        if (method.startsWith('litch/session/') || method.startsWith('litch/sessionProposal/'))
          return sessionTreeCall(
            this.host.sessionTree,
            this.host.sessionTreeOn(),
            method,
            frame.params,
            this.declared.has(EXTENSION.sessionTree),
          )
        // 统一模式（harnessConfig）：只是文件操作，设备进程自己做，不经主进程
        if (INSTRUCTIONS_METHODS.has(method)) return instructionsCall(method, frame.params)
        if (method.startsWith(MANAGEMENT_PREFIX))
          return this.host.management.call(method, frame.params)
        if (method.startsWith(DEVICE_TASK_PREFIX)) return this.tasks(method, frame.params)
        return this.calls.call(method, frame.params)
      case 'workspace':
        return this.workspace(method, frame.params)
      case 'unsupported':
        throw new DeviceError('unsupported', `聚合面不支持 ${method}：${route.hint}`, { method })
      case 'list':
        return listThreads(
          {
            // 歇着的（停用了、没装……）也交过去：它们的会话这一次列不出来，应答里要说明
            links: [...this.links.values()],
            link: (harness) => this.link(harness),
            index: this.host.index,
            workspaces: this.host.workspaces,
            timeoutMs: this.host.timing.listTimeoutMs,
            ...(this.declared.has(EXTENSION.sessionTree) ||
            this.declared.has(EXTENSION.backgroundTasks)
              ? {
                  decorate: (row: Record<string, unknown>) => {
                    if (this.declared.has(EXTENSION.sessionTree))
                      this.host.sessionTree.decorate(row)
                    if (this.declared.has(EXTENSION.backgroundTasks))
                      this.host.background.decorate(row)
                  },
                }
              : {}),
          },
          frame.params,
        )
      case 'harness':
        if (isHarnessConfigMethod(method))
          return this.harnessConfig(route.harness, id, method, frame, raw)
        return this.forward(this.link(route.harness), id, method, frame, raw)
      case 'thread': {
        // 归属和置顶归设备层，别的字段还是要到会话所属的引擎：拆开来做
        if (method === 'thread/metadata/update')
          return this.metadataUpdate(route.threadId, route.harness, frame.params)
        const owner = this.owner(route.threadId, route.harness)
        if (owner instanceof UpstreamLink) return this.forward(owner, id, method, frame, raw)
        return owner.then((link) => this.forward(link, id, method, frame, raw))
      }
    }
  }

  private link(harness: string): UpstreamLink {
    const link = this.links.get(harness)
    if (!link) throw new DeviceError('unknownHarness', `这台设备上没有配置 ${harness}`, { harness })
    return link
  }

  /**
   * harness 详情设置的方法（litch/harness/*）。适配器的引擎自己实现，原样转过去；
   * 原生 codex 不认识，交给设备进程替它整理的翻译器（native-codex.mts 的 dialect.harnessConfig）
   */
  private harnessConfig(
    harness: string,
    id: RpcId,
    method: string,
    frame: Frame,
    raw: string,
  ): unknown {
    const link = this.link(harness)
    if (!link.available)
      throw new HarnessConfigError(
        'unavailable',
        harness,
        text(
          `${harness} 现在不可用：${link.failure.message}`,
          `${harness} is not available right now`,
        ),
      )
    const translator = this.translator(link)
    if (!translator) return this.forward(link, id, method, frame, raw, true)
    return translator.call(method, isObject(frame.params) ? frame.params : {})
  }

  private translator(link: UpstreamLink): HarnessConfigTranslator | null {
    const known = this.translators.get(link.harness)
    if (known) return known
    const made = link.dialect.harnessConfig?.({
      harness: link.harness,
      ask: (method, params, timeoutMs) => this.query(link, method, params, timeoutMs),
      home: () => link.facts.home ?? null,
      envNames: () => this.host.harnessEnvNames(link.harness),
      bundledCatalog: () => this.host.codexCatalog(),
      autoTitle: {
        enabled: () => this.host.titles.enabled(link.harness),
        set: (value) => this.host.titles.setEnabled(link.harness, value),
      },
      notify: (method, params) => {
        if (this.declared.has(EXTENSION.harnessConfig)) this.announce(method, params)
      },
      changed: (part) => this.host.harnessConfigChanged({ harness: link.harness, part }),
    })
    if (!made) return null
    this.translators.set(link.harness, made)
    return made
  }

  /** 会话所属的上游。索引里有的立刻给出；没有的向各上游问一遍 */
  private owner(threadId: string, hint: string | null): UpstreamLink | Promise<UpstreamLink> {
    const known = this.host.index.lookup(threadId)
    const link = known ? this.links.get(known) : undefined
    if (link) return link
    // 索引里没有、客户端又指了路的，照它说的转；应答里有会话对象时自然会记下来
    if (hint) return this.link(hint)
    return this.locate(threadId).then((harness) => this.link(harness))
  }

  private unavailable(link: UpstreamLink, method: string): DeviceError {
    return new DeviceError(
      'harnessUnavailable',
      `${link.harness} 现在不可用：${link.failure.message}`,
      { harness: link.harness, method },
    )
  }

  /**
   * keepHarness：harness 参数也带过去。harnessConfig 的方法参数里本来就有它（引擎声明过这项扩展，认识它），
   * 别的方法上它是聚合面的扩展参数，上游不认识
   */
  private forward(
    link: UpstreamLink,
    id: RpcId,
    method: string,
    frame: Frame,
    raw: string,
    keepHarness = false,
  ): typeof HANDLED | Promise<typeof HANDLED> {
    const fields = isObject(frame.params) ? frame.params : null
    // 新建会话带的工作区是设备层的，先摘下来，应答回来时再记
    const { expectation, withhold } = fields
      ? this.host.workspaces.outgoing(method, fields)
      : { expectation: null, withhold: [] }
    // harness 是聚合面的扩展参数，上游没声明认识它，不能带过去
    const dropped = keepHarness ? withhold : ['harness', ...withhold]
    let params = fields
    if (fields && dropped.some((key) => key in fields))
      params = Object.fromEntries(Object.entries(fields).filter(([key]) => !dropped.includes(key)))
    // 客户端发起回合就是用户说了一句话：子会话的回报排着队的话，包好放在这句话前面（session-tree.mts）
    if (params && method === 'turn/start' && typeof params.threadId === 'string') {
      const input = this.host.sessionTree.beforeUserTurn(params.threadId, params.input)
      if (input) params = { ...params, input }
    }
    // 回合里插话、打断：模型在等用户选的 offer 卡当作在这里做
    if (params && method === 'turn/steer' && typeof params.threadId === 'string')
      this.host.sessionTree.userSpoke(params.threadId)
    if (params && method === 'turn/interrupt' && typeof params.threadId === 'string')
      this.host.sessionTree.interrupted(params.threadId)
    // 建会话带的 litch_sessions 换成设备进程按设置给的那份（“每回合收尾”开关、这个 harness 的“任务卡”开关，
    // session-tree.mts 的 currentSessionTools）
    if (params && method === 'thread/start') {
      const tools = this.host.sessionTree.currentSessionTools(params.dynamicTools, link.harness)
      if (tools) params = { ...params, dynamicTools: tools }
    }
    // 应答回来之后要记的（一个请求只有一个 after）
    const afterwards: ((result: unknown) => void)[] = []
    // 建会话时带的动态工具记下来：设备进程替这个会话派子会话时照样带上
    if (method === 'thread/start' && Array.isArray(params?.dynamicTools)) {
      const tools = params.dynamicTools as unknown[]
      afterwards.push((result) => {
        const thread = isObject(result) ? result.thread : null
        if (isObject(thread) && typeof thread.id === 'string')
          this.host.sessionTree.store.setTools(thread.id, tools)
      })
    }
    // 经聚合面新建的原生 codex 会话（聚合面只认声明了 harness 扩展的客户端，也就是 Litch）：第一回合结束后起名
    if (method === 'thread/start' && link.dialect === NATIVE_CODEX_DIALECT)
      afterwards.push((result) => {
        const thread = isObject(result) ? result.thread : null
        if (isObject(thread)) this.host.titles.born(link.harness, thread)
      })
    const send = (ready: Record<string, unknown> | null): typeof HANDLED => {
      if (afterwards.length)
        this.relay.after(id, (result) => {
          for (const work of afterwards) work(result)
        })
      // 这个上游的“话”里要另外带的参数（原生 codex：选了权限预设时配套的审批策略）
      let outgoing = ready
      if (outgoing) outgoing = link.dialect.outgoing(method, outgoing) ?? outgoing
      const text = outgoing === fields ? raw : JSON.stringify({ ...frame, params: outgoing })
      if (!link.forward(id, method, text)) throw this.unavailable(link, method)
      // 退订不等应答：之后到的客户端工具调用不再按订阅者挑给它
      if (method === 'thread/unsubscribe')
        if (typeof fields?.threadId === 'string')
          this.host.clientTools.unsubscribed(this, link.harness, fields.threadId)
      if (expectation) this.relay.expect(link, id, expectation)
      return HANDLED
    }
    // 原生 codex 建会话、恢复、分叉：先补齐开发者指令（可能要先问它一句 config/read），再转（codex-instructions.mts）
    const prepared = params
      ? link.dialect.instructions?.(method, params, {
          ask: (asked, given) => this.query(link, asked, given),
          store: this.host.sessionTree.store,
          log: (line) => this.host.log(`${this.tag} ${line}`),
        })
      : null
    if (!prepared) return send(params)
    return prepared.then(({ params: ready, remember }) => {
      afterwards.push(remember)
      return send(ready)
    })
  }

  /** 设备层自己向一个上游问一句，等它的应答 */
  private async query(
    link: UpstreamLink,
    method: string,
    params: unknown,
    timeoutMs = this.host.timing.probeTimeoutMs,
  ): Promise<unknown> {
    if (!link.available) throw this.unavailable(link, method)
    try {
      return await link.request(method, params, timeoutMs)
    } catch (error) {
      // 上游明确回的错误原样带给客户端（和转发的请求一样，它那种“话”里意思不一样的才换）；
      // 等的时候它断开了的，照“不可用”报
      if (error instanceof UpstreamRpcError) {
        const { code, message, data } = error
        const replaced = link.dialect.rejection(link.harness, method, { code, message, data })
        throw replaced ? new UpstreamRpcError(replaced) : error
      }
      if (link.available) throw error
      throw this.unavailable(link, method)
    }
  }

  /**
   * 工作区、分区的方法由设备层处理。参数里提到的会话要是这台设备上真有的：
   * 索引里没有的先向各上游问一遍。
   */
  private async workspace(method: string, params: unknown): Promise<unknown> {
    const fields = isObject(params) ? params : {}
    const known = async (threadId: unknown): Promise<void> => {
      if (typeof threadId !== 'string' || !threadId) return
      if (this.host.index.lookup(threadId) === null) await this.locate(threadId)
    }
    if (method === 'thread/section/move') await known(fields.threadId)
    if (method === 'project/import' && Array.isArray(fields.threads))
      // 找不到的不在这里报：幂等键已经用过时照旧返回那个项目，没用过时由存储说“导入包含未知会话”
      await Promise.all(fields.threads.map((threadId) => known(threadId).catch(() => null)))
    return this.host.workspaces.call(method, params)
  }

  /**
   * `thread/metadata/update`：归属（projectId）和置顶（isPinned）记在设备层，其余字段（git 信息等）
   * 照旧交给会话所属的引擎。没有别的字段时不去动引擎，只向它要一份会话对象来答。
   */
  private async metadataUpdate(
    threadId: string,
    hint: string | null,
    params: unknown,
  ): Promise<unknown> {
    const fields = isObject(params) ? params : {}
    const { workspaces } = this.host
    // 写法照协议：不带或 null 是不改，空字符串是解除，别的是归到那个工作区
    const projectId =
      fields.projectId == null
        ? undefined
        : fields.projectId === ''
          ? null
          : requiredString(fields.projectId, 'projectId')
    if (projectId != null) workspaces.requireProject(projectId)
    const link = await this.owner(threadId, hint)
    const rest = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !DEVICE_METADATA.has(key)),
    )
    const more = Object.keys(rest).some((key) => key !== 'threadId')
    const result = more
      ? await this.query(link, 'thread/metadata/update', rest)
      : await this.query(link, 'thread/read', { threadId, includeTurns: false })
    const thread = isObject(result) ? result.thread : null
    if (!isObject(thread) || thread.id !== threadId)
      throw new ProtocolError(-32603, `${link.harness} 没有给回这个会话`)
    // 上游认了这个会话，设备层才记
    this.host.index.see(
      { id: threadId, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
      link.harness,
    )
    if (projectId !== undefined) workspaces.assign(threadId, projectId)
    if (typeof fields.isPinned === 'boolean') workspaces.pin(threadId, fields.isPinned)
    thread.harness = link.harness
    workspaces.decorate(threadId, thread)
    if (this.declared.has(EXTENSION.sessionTree)) this.host.sessionTree.decorate(thread)
    return more ? result : { thread }
  }

  /** 不认识的会话向各上游问一遍再记下来（比如刚在命令行里开的） */
  private locate(threadId: string): Promise<string> {
    let probe = this.probes.get(threadId)
    if (!probe) {
      probe = this.ask(threadId).finally(() => this.probes.delete(threadId))
      this.probes.set(threadId, probe)
    }
    return probe.then((harness) => {
      if (harness) return harness
      const unavailable = [...this.links.values()]
        .filter((link) => !link.available && !link.parked)
        .map((link) => link.harness)
      throw new DeviceError(
        'unknownThread',
        unavailable.length
          ? `没有找到会话 ${threadId}（${unavailable.join('、')} 现在不可用，没有问到）`
          : `没有哪个 harness 认识会话 ${threadId}`,
        { threadId, unavailable },
      )
    })
  }

  private ask(threadId: string): Promise<string | null> {
    const ready = [...this.links.values()].filter((link) => link.available)
    return new Promise((resolve) => {
      let left = ready.length
      const miss = () => {
        if (--left === 0) resolve(null)
      }
      if (left === 0) resolve(null)
      for (const link of ready)
        link
          .request(
            'thread/read',
            { threadId, includeTurns: false },
            this.host.timing.probeTimeoutMs,
          )
          .then((result) => {
            const thread = isObject(result) ? result.thread : null
            if (!isObject(thread) || thread.id !== threadId) return miss()
            this.host.index.see(
              { id: threadId, updatedAt: thread.updatedAt, ephemeral: thread.ephemeral },
              link.harness,
            )
            resolve(link.harness)
          }, miss)
    })
  }

  private describe(link: UpstreamLink): HarnessInfo {
    const seen = link.facts.userAgent !== null || link.facts.runtime !== null
    let unavailable: HarnessUnavailable | null = link.available ? null : link.failure
    // 说明的两种语言版本是 deviceSettings 扩展的内容，只给声明过它的连接
    if (unavailable?.text && !this.declared.has(EXTENSION.deviceSettings))
      unavailable = { kind: unavailable.kind, message: unavailable.message }
    return describeHarness(
      link.harness,
      seen ? link.facts : this.host.catalog.latest(link.harness),
      unavailable,
    )
  }

  /** 设备信息。会话编排开着才列 sessionTree：客户端按它决定带不带 litch_sessions、出不出派子会话的界面 */
  private deviceInfo(): DeviceInfo {
    const { info } = this.host
    return this.host.sessionTreeOn()
      ? { ...info, extensions: [...info.extensions, EXTENSION.sessionTree] }
      : info
  }

  private runtimeInfo(): DeviceRuntimeInfo {
    const harnesses: HarnessInfo[] = []
    for (const source of this.host.harnesses()) {
      const link = this.links.get(source.id)
      if (link) harnesses.push(this.describe(link))
    }
    const service = this.host.service() ?? null
    const declared = this.declared.has(EXTENSION.deviceService)
    const device = describeDevice(this.deviceInfo(), service, declared)
    // 设备的时区属于 deviceTasks：声明了的连接才看得到（表单按它预览“下一次”）
    return {
      device: this.declared.has(EXTENSION.deviceTasks)
        ? { ...device, timezone: localTaskTimeZone() }
        : device,
      harnesses,
    }
  }

  /** 定时任务的方法。只给声明过 deviceTasks 的连接 */
  private tasks(method: string, params: unknown): unknown {
    const declared = this.declared.has(EXTENSION.deviceTasks)
    if (!this.host.tasks) {
      if (!declared)
        throw new DeviceError(
          'extensionRequired',
          `${method} 属于 ${EXTENSION.deviceTasks} 扩展，握手时在 capabilities.litchExtensions 里声明了它才能用`,
          { method, required: [EXTENSION.deviceTasks] },
        )
      throw new DeviceError('unsupported', `聚合面不支持 ${method}：这台设备上的定时任务不可用`, {
        method,
      })
    }
    return this.host.tasks.call(method, params, declared)
  }

  /** 给一个 harness 开一条上游连接。主进程说它没在跑的话先歇着，不去连 */
  private open(source: HarnessSource): UpstreamLink {
    const { timing } = this.host
    const link = new UpstreamLink({
      harness: source.id,
      connect: source.connect,
      // 对面是适配器的运行时还是原生的 codex：适配器主进程说了算，没有它管着的看启动配置
      dialect: dialectFor(source.managed ? source.managed.native : source.native),
      // 客户端声明的能力带给上游，包括它认识哪些扩展（原生 codex 不认识扩展键，握手时会摘掉）。
      // 设备进程自己执行的命名空间（litch_tasks、litch_sessions）也替这条连接声明上：适配器的入口挑执行方时挑得中它，
      // 调用落到这条连接上，设备进程在这里拦下（relay.mts）
      initializeParams: declareDeviceTools(
        this.initializeParams,
        this.host.deviceTools.namespaces(),
      ),
      retryMs: timing.retryMs,
      handshakeTimeoutMs: timing.handshakeTimeoutMs,
      frame: (from, frame, raw, request) => this.relay.upstream(from, frame, raw, request),
      status: (from) => this.status(from),
      dropped: (from, pending: ForwardedRequest[]) => this.relay.dropped(from, pending),
    })
    this.links.set(source.id, link)
    if (!source.managed || source.managed.state === 'running') link.start()
    else this.steer(link, source.managed)
    return link
  }

  /** 照主进程说的状态摆这条连接：起来了就去连，没在跑就歇着并照它给的原因报 */
  private steer(link: UpstreamLink, managed: ManagedHarness): void {
    if (managed.state === 'running') {
      link.resume()
      return
    }
    link.suspend({
      kind: managed.state,
      message: managed.text?.['zh-CN'] ?? '这个 harness 现在没有在运行',
      ...(managed.text ? { text: managed.text } : {}),
    })
  }

  /** 这台设备上的 harness 名单或者它们的状态变了（适配器主进程告诉设备进程的） */
  sync(): void {
    if (this.state !== 'initializing' && this.state !== 'ready') return
    for (const source of this.host.harnesses()) {
      const link = this.links.get(source.id)
      if (!link) this.open(source)
      else if (source.managed) this.steer(link, source.managed)
    }
  }

  /** 设置或者 SSH 入口的状况变了。只发给声明过 deviceSettings 的连接 */
  settingsChanged(params: DeviceSettingsChangedNotification): void {
    if (this.state !== 'ready' || !this.declared.has(EXTENSION.deviceSettings)) return
    if (this.optOut.has(DEVICE_SETTINGS_CHANGED)) return
    this.send(JSON.stringify({ method: DEVICE_SETTINGS_CHANGED, params }))
  }

  /** 握手已经完成、还没有断开 */
  get ready(): boolean {
    return this.state === 'ready'
  }

  /**
   * 设备层自己产生的通知（工作区、归属、分区变了）。握手完成之前的不发：
   * 客户端握手之后读到的就是最新的。extension 给了就只发给声明过它的连接。
   */
  announce(method: string, params: unknown, extension?: string): void {
    if (this.state !== 'ready') return
    if (extension !== undefined && !this.declared.has(extension)) return
    if (this.optOut.has(method)) return
    this.send(JSON.stringify({ method, params }))
  }

  /**
   * 设备进程自己建出来的会话（派出的子会话）：照引擎的样子发一条 thread/started，会话对象挂上 harness、
   * 设备层的归属，声明了 sessionTree 的再挂上 litchLineage。各条连接各自一份
   */
  threadStarted(harness: string, thread: Record<string, unknown>): void {
    if (
      this.state !== 'ready' ||
      this.optOut.has('thread/started') ||
      typeof thread.id !== 'string'
    )
      return
    const copy: Record<string, unknown> = { ...thread, harness }
    this.host.workspaces.decorate(thread.id, copy)
    if (this.declared.has(EXTENSION.sessionTree)) this.host.sessionTree.decorate(copy)
    this.send(JSON.stringify({ method: 'thread/started', params: { thread: copy } }))
  }

  /** 一个上游的状态变了：真的和上次报的不一样才通知客户端 */
  private status(link: UpstreamLink): void {
    if (link.available) {
      this.host.catalog.update(link.harness, link.facts)
      this.host.reachable(link.harness)
    }
    // 握手应答之前的变化不用通知，客户端从 runtime/info 里看到的就是最新的
    if (this.state !== 'ready') return
    const info = this.describe(link)
    const text = JSON.stringify(info)
    if (this.announced.get(link.harness) === text) return
    this.announced.set(link.harness, text)
    this.note(info, link.detail)
    if (this.optOut.has(HARNESS_STATUS_CHANGED)) return
    const params = { harness: link.harness, info }
    this.send(JSON.stringify({ method: HARNESS_STATUS_CHANGED, params }))
  }

  private async initialize(id: RpcId, params: unknown): Promise<typeof HANDLED> {
    if (this.state !== 'new') throw new ProtocolError(-32600, 'Already initialized')
    const fields = isObject(params) ? params : {}
    const capabilities = isObject(fields.capabilities) ? fields.capabilities : {}
    const declared = strings(capabilities[EXTENSIONS_CAPABILITY])
    if (REQUIRED_EXTENSIONS.some((name) => !declared.includes(name)))
      throw new DeviceError(
        'extensionRequired',
        `这是设备服务的聚合入口，要求客户端握手时在 capabilities.${EXTENSIONS_CAPABILITY} 里声明认识这些扩展：${REQUIRED_EXTENSIONS.join('、')}。只说标准 Codex 协议的客户端请连各个 harness 自己的入口`,
        { required: [...REQUIRED_EXTENSIONS], supported: [...this.deviceInfo().extensions] },
      )
    this.state = 'initializing'
    this.declared = new Set(declared)
    this.initializeParams = params
    this.clientToolNamespaces = clientToolNamespaces(params)
    this.desktop = this.clientToolNamespaces.size ? desktopOf(capabilities) : null
    // 退订名单在路由层生效：被退订的通知直接不转发
    this.optOut = new Set(strings(capabilities.optOutNotificationMethods))
    const { timing } = this.host
    for (const source of this.host.harnesses()) this.open(source)
    // 上游可以暂时连不上，握手不等它：到点没有结果的先报成不可用。
    // 正赶上设备层在从引擎导入现有的项目（第一次启用、某个 harness 刚连上）的话也等一等，
    // 这样客户端握手之后第一次读到的工作区就是全的；到点没完的，导入完了会有通知
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all([...this.links.values()].map((link) => link.settled)).then(() =>
        this.host.importing(),
      ),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timing.settleMs)
      }),
    ])
    clearTimeout(timer)
    if (this.state !== 'initializing') return HANDLED
    const client = isObject(fields.clientInfo) ? fields.clientInfo : {}
    const result = {
      userAgent: codexUserAgent(
        typeof client.name === 'string' ? client.name : 'codex-app',
        typeof client.version === 'string' ? client.version : 'unknown',
        CODEX_PROTOCOL_VERSION,
        'codex-harness-adapter-device',
      ),
      codexHome: this.host.stateDir,
      platformFamily: platformFamily(),
      platformOs: platformOs(),
    }
    // 握手应答必须是客户端收到的第一帧：先发它，再放出这期间上游已经发来的通知
    this.wire.send(JSON.stringify({ id, result }))
    // 名字和版本是客户端自己报的，原样进日志之前先转成一行
    this.host.log(`${this.tag} 握手完成：${JSON.stringify([client.name, client.version])}`)
    this.traced(id, null)
    this.host.trace?.('peer.ready', {
      conn: this.id.slice(0, 8),
      client: typeof client.name === 'string' ? client.name.slice(0, 100) : null,
      version: typeof client.version === 'string' ? client.version.slice(0, 100) : null,
      extensions: this.declared.size,
    })
    for (const link of this.links.values()) {
      const info = this.describe(link)
      this.announced.set(link.harness, JSON.stringify(info))
      this.note(info, link.detail)
    }
    const held = this.gate ?? []
    this.gate = null
    this.state = 'ready'
    this.host.clientTools.join(this)
    for (const text of held) this.wire.send(text)
    // 有客户端连着了：没人连着时攒下的唤醒现在可以做了
    this.host.sessionTree.clientJoined()
    return HANDLED
  }
}
