// 一台设备上各 harness 的详情设置（协议扩展 harnessConfig，15 号设计）在客户端这一头的样子。
// 权威在 harness 自己的原生配置里，读写由设备上的引擎（原生 codex 由设备进程翻译）做；核心只是转运：
// - 每个 harness 一份数据，harnessConfig 主题开着（详情设置页）才去读；四块各读各的，谁读不成不耽误别的；
//   config 读回来说有模型清单（modelCatalog）才接着读第五块 models，没有就让它空着；
// - 别处改了（litch/harness/config/changed）重读那一块并记一次“被动过”，自己刚写的那一下引出来的不算；
// - 带版本的写入撞上版本冲突：重读那一块，以 conflict 结束，界面留着用户的改动再确认；
// - 登录（auth/start、mcp/login）的每一步记在 attempts 里，后来的进展跟着 litch/harness/auth/updated；
//   openUrl 带着回调端口、设备又是远程的，先经外壳把本机同一个端口用 ssh -L 转到设备上；
// - 只认环境变量的密钥（env 方式）写进设备设置里这个 harness 的环境变量表（deviceSettings），不经引擎；
// - 统一模式（litch/device/instructions/*）由设备进程自己做，这里先把各 harness 的指令文件读一遍拿到路径。
// 通知只发给握手时声明了 harnessConfig 的连接（connection/link.mts 里声明了）。
import {
  HARNESS_CONFIG_METHOD,
  HARNESS_CONFIG_NOTIFICATION,
  type HarnessAuthStartResponse,
  type HarnessAuthUpdatedNotification,
  type HarnessConfigChangedNotification,
  type HarnessConfigErrorData,
} from '../../../protocol/src/harness-config.mjs'
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { ChannelError, type HarnessConfigOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError, type RpcRequestOptions } from '../connection/rpc.mjs'
import type { RemoteTarget } from '../model.mjs'
import type {
  HarnessConfigTopicView,
  HcAttempt,
  HcAuthStep,
  HcConfigView,
  HcEdit,
  HcInstructionsView,
  HcMcpServer,
  HcMcpView,
  HcModelEntry,
  HcModelsView,
  HcPart,
  HcProvidersView,
  HcSlot,
  HcValue,
  InstructionsLinkResult,
  InstructionsOverview,
} from '../model-harness-config.mjs'
import type { EnvEntryView } from '../model-manage.mjs'
import {
  outgoingMcp,
  outgoingModels,
  projectConfig,
  projectInstructions,
  projectMcp,
  projectModels,
  projectProviders,
  projectStep,
} from '../projection/harness-config.mjs'
import { bilingual, outgoingEdits, projectManage } from '../projection/manage.mjs'

/** 外壳给的：把这台电脑上的一个端口经 ssh 转到远程设备上的同一个端口（登录的回调要用） */
export interface AuthForwardPlatform {
  /** 等到本机端口能连上才回；已经转着的直接回。转不成就抛（带原话） */
  open(deviceId: string, target: RemoteTarget, port: number): Promise<void>
}

export interface HarnessConfigHost {
  deviceId: string
  /** 远程设备的 ssh 目标；本机是 null */
  target(): RemoteTarget | null
  online(): boolean
  /** 设备信息的 extensions 里列了 harnessConfig */
  deviceSupported(): boolean
  /** 这个 harness 的声明里有 harnessConfig */
  harnessSupported(harness: string): boolean
  /** 设备上声明了 harnessConfig 的 harness，按设备声明的顺序（统一模式要把它们的指令文件都读一遍） */
  configurable(): string[]
  nameOf(harness: string): string
  /** 外壳给的转发。没有（浏览器里的开发预览、测试）就转不了 */
  forward: AuthForwardPlatform | null
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 请求没做成：换成给人看的错误 */
  fail(error: unknown): ChannelError
  now(): number
  log(line: string): void
}

export interface HarnessConfig {
  /** 订阅一个 harness 的详情设置。先给快照，之后给增量；返回退订函数 */
  open(harness: string, sink: HostSink): () => void
  /** 连上并认出对面是谁了：开着的重读一遍 */
  resync(): void
  /** 连接断了：在途的结果都不算数，进行中的登录作废 */
  offline(): void
  /** 是详情设置的通知就处理掉并返回 true */
  notification(method: string, params: unknown): boolean
  /** 这个 harness 刚重启过（不管是谁点的）：要重启才生效的已经用上了，数据重读 */
  restarted(harness: string): void
  write(
    harness: string,
    edits: readonly HcEdit[],
    expectedVersion: string,
  ): Promise<{ overriddenKeys: string[]; restartRequired: boolean }>
  action(harness: string, actionId: string): Promise<void>
  reload(harness: string, part: HcPart | undefined): Promise<void>
  upsertProvider(
    harness: string,
    providerId: string,
    templateId: string,
    definition: Record<string, HcValue>,
    expectedVersion: string,
  ): Promise<{ restartRequired: boolean }>
  removeProvider(harness: string, providerId: string): Promise<{ restartRequired: boolean }>
  discoverModels(
    harness: string,
    providerId: string,
  ): Promise<{ models: Array<{ id: string; title: string | null }> }>
  activateProvider(
    harness: string,
    providerId: string,
    expectedVersion: string,
  ): Promise<{ restartRequired: boolean }>
  startAuth(
    harness: string,
    providerId: string,
    methodId: string,
    inputs: Record<string, string> | undefined,
  ): Promise<string>
  continueAuth(harness: string, attemptId: string, inputs: Record<string, string>): Promise<void>
  cancelAuth(harness: string, attemptId: string): Promise<void>
  dismissAuth(harness: string, attemptId: string): void
  logout(harness: string, providerId: string): Promise<void>
  setEnv(harness: string, name: string, value: string | null): Promise<{ restartRequired: boolean }>
  upsertMcp(
    harness: string,
    server: HcMcpServer,
    previousName: string | undefined,
    expectedVersion: string,
  ): Promise<{ restartRequired: boolean }>
  removeMcp(
    harness: string,
    name: string,
    expectedVersion: string,
  ): Promise<{ restartRequired: boolean }>
  loginMcp(harness: string, name: string): Promise<string>
  writeInstructions(harness: string, content: string, expectedHash: string): Promise<string>
  /** 整份写模型清单；entries 为 null 是回到 harness 自带的模型目录（不能是空数组） */
  writeModels(
    harness: string,
    entries: readonly HcModelEntry[] | null,
    expectedVersion: string,
  ): Promise<{ restartRequired: boolean }>
  overview(): Promise<InstructionsOverview>
  unify(harness: string, content: string): Promise<InstructionsLinkResult[]>
  separate(): Promise<string[]>
}

const PARTS: readonly HcPart[] = ['config', 'providers', 'mcp', 'instructions', 'models']
/** 打开、重连、重启后直接读的四块；models 跟在 config 后面读（要先知道有没有模型清单） */
const BASIC: readonly HcPart[] = ['config', 'providers', 'mcp', 'instructions']
/** 自己写完多久之内到的“变了”的通知算是自己引出来的 */
const OWN_ECHO_MS = 2_000
/** 登录、写入都可能要对面跑一阵（起命令行、写钥匙串），默认的三十秒不够 */
const WAIT_MS = 120_000

const emptySlot = <T,>(): HcSlot<T> => ({ data: null, loading: false, error: null, revision: 0 })

interface Entry {
  harness: string
  sinks: Set<HostSink>
  slots: {
    config: HcSlot<HcConfigView>
    providers: HcSlot<HcProvidersView>
    mcp: HcSlot<HcMcpView>
    instructions: HcSlot<HcInstructionsView>
    models: HcSlot<HcModelsView>
  }
  /** 下一次 config 读完要不要接着重读 models（整个重读时为真；平常只在 models 还没读过时才接着读） */
  withModels: boolean
  /** 每一块正在读的那一趟，和“读的途中又说要读”（再读一遍） */
  reading: Partial<Record<HcPart, boolean>>
  again: Partial<Record<HcPart, boolean>>
  /** 每一块自己正在写几次、最近一次写完是什么时候：期间和之后一小会儿的“变了”算自己的 */
  writing: Partial<Record<HcPart, number>>
  wroteAt: Partial<Record<HcPart, number>>
  attempts: Map<string, HcAttempt>
  restartRequired: boolean
  /** 没人看的时候到过“变了”的通知（或者断开过）：下次有人订阅要重读 */
  stale: boolean
}

/** harnessConfig 扩展的错误 → 通道上的错误。不是它的交给设备的那一套 */
function hcFailure(error: unknown, fallback: (error: unknown) => ChannelError): ChannelError {
  if (error instanceof RpcError) {
    const data = error.data as Partial<HarnessConfigErrorData> | null | undefined
    const reason = typeof data === 'object' && data !== null ? data.litch : undefined
    const said = data?.message ? { said: bilingual(data.message) } : {}
    const key = typeof data?.key === 'string' ? { key: data.key } : {}
    switch (reason) {
      case 'versionConflict':
        return new ChannelError('conflict', error.message, undefined, said)
      case 'readOnly':
        return new ChannelError('rejected', error.message, undefined, { ...said, ...key })
      case 'invalidValue':
        return new ChannelError('invalid', error.message, undefined, { ...said, ...key })
      case 'notFound':
        return new ChannelError('notFound', error.message, undefined, said)
      case 'authFailed':
      case 'unavailable':
        return new ChannelError('remote', error.message, undefined, said)
    }
  }
  return fallback(error)
}

export function createHarnessConfig(host: HarnessConfigHost): HarnessConfig {
  const entries = new Map<string, Entry>()
  /** 断开、重连都换一个代号：回来的结果不是这一轮的就作废 */
  let epoch = 0
  /** 连上过、认出过对面：supported 才说得准 */
  let known = false

  const entryOf = (harness: string): Entry => {
    let entry = entries.get(harness)
    if (!entry) {
      entry = {
        harness,
        sinks: new Set(),
        slots: {
          config: emptySlot(),
          providers: emptySlot(),
          mcp: emptySlot(),
          instructions: emptySlot(),
          models: emptySlot(),
        },
        withModels: false,
        reading: {},
        again: {},
        writing: {},
        wroteAt: {},
        attempts: new Map(),
        restartRequired: false,
        stale: true,
      }
      entries.set(harness, entry)
    }
    return entry
  }

  const supported = (harness: string) => host.deviceSupported() && host.harnessSupported(harness)

  const view = (entry: Entry): HarnessConfigTopicView => ({
    deviceId: host.deviceId,
    harness: entry.harness,
    supported: known ? supported(entry.harness) : null,
    config: { ...entry.slots.config },
    providers: { ...entry.slots.providers },
    mcp: { ...entry.slots.mcp },
    instructions: { ...entry.slots.instructions },
    models: { ...entry.slots.models },
    attempts: [...entry.attempts.values()].map((attempt) => ({
      ...attempt,
      forward: attempt.forward ? { ...attempt.forward } : null,
    })),
    restartRequired: entry.restartRequired,
  })

  const emit = (entry: Entry) => {
    if (entry.sinks.size === 0) return
    const ops: HarnessConfigOp[] = [{ op: 'hc.set', view: view(entry) }]
    for (const sink of entry.sinks) sink.delta(ops)
  }

  const fail = (error: unknown) => hcFailure(error, host.fail)

  const reachable = (harness: string) => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
    if (!supported(harness)) {
      throw new ChannelError('unsupported', `${host.nameOf(harness)} 暂不支持详情设置`)
    }
  }

  /** 读一块。正在读的时候又要读：读完再读一遍（中间那次变化可能没赶上） */
  const load = async (entry: Entry, part: HcPart): Promise<void> => {
    if (!host.online() || !supported(entry.harness)) return
    if (part === 'models' && entry.slots.config.data?.modelCatalog !== true) {
      // 还不知道有没有（config 没读到）或者没有：读 config，有的话它读完接着读 models
      entry.withModels = true
      return load(entry, 'config')
    }
    if (entry.reading[part]) {
      entry.again[part] = true
      return
    }
    const mine = epoch
    entry.reading[part] = true
    const slot = entry.slots[part]
    slot.loading = true
    emit(entry)
    const params = { harness: entry.harness }
    try {
      if (part === 'config') {
        const raw = await host.request(HARNESS_CONFIG_METHOD.configRead, params)
        if (mine === epoch) {
          entry.slots.config.data = projectConfig(raw)
          followModels(entry)
        }
      } else if (part === 'models') {
        const raw = await host.request(HARNESS_CONFIG_METHOD.modelsRead, params)
        if (mine === epoch) entry.slots.models.data = projectModels(raw)
      } else if (part === 'providers') {
        const raw = await host.request(HARNESS_CONFIG_METHOD.providersRead, params)
        if (mine === epoch) entry.slots.providers.data = projectProviders(raw)
      } else if (part === 'mcp') {
        const raw = await host.request(HARNESS_CONFIG_METHOD.mcpRead, params)
        if (mine === epoch) entry.slots.mcp.data = projectMcp(raw)
      } else {
        const raw = await host.request(HARNESS_CONFIG_METHOD.instructionsRead, params)
        if (mine === epoch) entry.slots.instructions.data = projectInstructions(raw)
      }
      if (mine === epoch) slot.error = null
    } catch (error) {
      if (mine === epoch) {
        host.log(`读 ${entry.harness} 的 ${part} 失败：${String(error)}`)
        slot.error = fail(error).toShape()
      }
    } finally {
      if (mine === epoch) {
        entry.reading[part] = false
        slot.loading = false
        emit(entry)
        if (entry.again[part]) {
          entry.again[part] = false
          void load(entry, part)
        }
      }
    }
  }

  /** config 刚读到：有模型清单就接着读 models（整个重读、或者还没读过时）；没有就清空那一块 */
  const followModels = (entry: Entry) => {
    const models = entry.slots.models
    if (entry.slots.config.data?.modelCatalog !== true) {
      entry.withModels = false
      models.data = null
      models.error = null
      return
    }
    if (entry.withModels || (models.data === null && !entry.reading.models)) {
      entry.withModels = false
      void load(entry, 'models')
    }
  }

  const loadAll = (entry: Entry) => {
    entry.stale = false
    entry.withModels = true
    for (const part of BASIC) void load(entry, part)
  }

  /** 写一块：成了之后重读那一块；版本冲突也重读，再以 conflict 结束 */
  const writing = async <T,>(harness: string, part: HcPart, run: () => Promise<T>): Promise<T> => {
    reachable(harness)
    const entry = entryOf(harness)
    entry.writing[part] = (entry.writing[part] ?? 0) + 1
    try {
      const result = await run()
      entry.wroteAt[part] = host.now()
      void load(entry, part)
      return result
    } catch (error) {
      const failed = fail(error)
      if (failed.code === 'conflict') void load(entry, part)
      throw failed
    } finally {
      entry.writing[part] = Math.max(0, (entry.writing[part] ?? 1) - 1)
    }
  }

  /** 写入的应答说要重启：记下来，界面一直提示到重启为止 */
  const needsRestart = (harness: string, restart: boolean) => {
    if (!restart) return
    const entry = entryOf(harness)
    entry.restartRequired = true
    emit(entry)
  }

  // ---------- 登录 ----------

  const attemptOf = (harness: string, attemptId: string): HcAttempt => {
    const attempt = entries.get(harness)?.attempts.get(attemptId)
    if (!attempt) throw new ChannelError('notFound', '该登录已失效')
    return attempt
  }

  /** 回调要转发时，先把本机同一个端口转到设备上 */
  const forwardFor = (entry: Entry, attempt: HcAttempt, step: HcAuthStep) => {
    if (step.kind !== 'openUrl' || step.callbackPort === null) {
      attempt.forward = null
      return
    }
    const target = host.target()
    if (!target) {
      attempt.forward = null
      return
    }
    const port = step.callbackPort
    if (attempt.forward?.port === port && attempt.forward.state !== 'failed') return
    if (!host.forward) {
      attempt.forward = { port, state: 'unavailable', message: null }
      return
    }
    attempt.forward = { port, state: 'opening', message: null }
    const mine = epoch
    host.forward.open(host.deviceId, target, port).then(
      () => {
        if (mine !== epoch || attempt.forward?.port !== port) return
        attempt.forward = { port, state: 'ready', message: null }
        emit(entry)
      },
      (error: unknown) => {
        if (mine !== epoch || attempt.forward?.port !== port) return
        host.log(`登录回调的端口 ${port} 没转成：${String(error)}`)
        attempt.forward = {
          port,
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }
        emit(entry)
      },
    )
  }

  /** 登录有了新的一步 */
  const advance = (entry: Entry, attempt: HcAttempt, step: HcAuthStep) => {
    attempt.step = step
    attempt.busy = false
    forwardFor(entry, attempt, step)
    if (step.kind === 'done') {
      // 凭据变了：provider 的状态（MCP 的连接状态）重读
      void load(entry, attempt.mcpServer ? 'mcp' : 'providers')
    }
    emit(entry)
  }

  const adopt = (
    harness: string,
    response: HarnessAuthStartResponse,
    who: { providerId: string | null; mcpServer: string | null },
  ): string => {
    const entry = entryOf(harness)
    const attemptId = String(response?.attemptId ?? '')
    const known = entry.attempts.get(attemptId)
    // 进展的通知可能比应答先到：那样它更新，不拿应答里的第一步盖回去
    if (known) return attemptId
    const attempt: HcAttempt = {
      attemptId,
      ...who,
      step: projectStep(response?.step),
      forward: null,
      busy: false,
    }
    entry.attempts.set(attemptId, attempt)
    advance(entry, attempt, attempt.step)
    return attemptId
  }

  // ---------- 统一模式 ----------

  const overview = async (): Promise<InstructionsOverview> => {
    if (!host.online()) throw new ChannelError('offline', '设备未连接')
    if (!host.deviceSupported()) throw new ChannelError('unsupported', '此设备不支持详情设置')
    const harnesses = host.configurable()
    const read = await Promise.all(
      harnesses.map(async (harness) => {
        try {
          const raw = await host.request(HARNESS_CONFIG_METHOD.instructionsRead, { harness })
          return {
            harness,
            name: host.nameOf(harness),
            info: projectInstructions(raw),
            error: null,
          }
        } catch (error) {
          return { harness, name: host.nameOf(harness), info: null, error: fail(error).toShape() }
        }
      }),
    )
    return { entries: read, unified: unifiedOf(read) }
  }

  /** 统一着的那几份都重读：开着的界面马上看到软链 */
  const reloadInstructions = () => {
    for (const entry of entries.values()) {
      if (entry.sinks.size > 0) void load(entry, 'instructions')
      else entry.stale = true
    }
  }

  return {
    open(harness, sink) {
      const entry = entryOf(harness)
      const first = entry.sinks.size === 0
      entry.sinks.add(sink)
      sink.snapshot(view(entry))
      if ((first && entry.stale) || BASIC.every((part) => entry.slots[part].data === null)) {
        if (host.online()) loadAll(entry)
      }
      return () => {
        entry.sinks.delete(sink)
        // 没人看了：之后到的变化不跟，下次打开整个重读
        if (entry.sinks.size === 0) entry.stale = true
      }
    },

    resync() {
      epoch++
      known = true
      for (const entry of entries.values()) {
        for (const part of PARTS) {
          entry.reading[part] = false
          entry.again[part] = false
          entry.slots[part].loading = false
        }
        if (entry.sinks.size > 0) loadAll(entry)
        else entry.stale = true
        emit(entry)
      }
    },

    offline() {
      epoch++
      for (const entry of entries.values()) {
        // 设备断开（设备服务重启也算）：进行中的登录随它没了
        for (const attempt of entry.attempts.values()) {
          if (attempt.step.kind !== 'done' && attempt.step.kind !== 'failed') {
            attempt.step = {
              kind: 'failed',
              message: {
                'zh-CN': '设备已断开，登录未完成',
                en: 'The device disconnected before login finished',
              },
            }
            attempt.busy = false
          }
        }
        for (const part of PARTS) entry.slots[part].loading = false
        entry.stale = true
        emit(entry)
      }
    },

    notification(method, params) {
      if (method === HARNESS_CONFIG_NOTIFICATION.changed) {
        const note = params as HarnessConfigChangedNotification | null
        if (!note || typeof note.harness !== 'string') return true
        const entry = entries.get(note.harness)
        const part = (PARTS as readonly string[]).includes(note.part) ? (note.part as HcPart) : null
        if (!entry || !part) return true
        if (entry.sinks.size === 0) {
          entry.stale = true
          return true
        }
        // 自己正在写、刚写完的那一下引出来的不算“被别处改过”。看的是这个 harness 的每一块：
        // 几块落在同一个文件上时（原生 codex 的 config.toml），写了其中一块，设备会把别的几块也报成变了，
        // 那是让它们重读拿新版本，不是别处改了它们的内容
        const own = PARTS.some(
          (each) =>
            (entry.writing[each] ?? 0) > 0 ||
            host.now() - (entry.wroteAt[each] ?? -Infinity) < OWN_ECHO_MS,
        )
        if (!own) entry.slots[part].revision++
        void load(entry, part)
        return true
      }
      if (method === HARNESS_CONFIG_NOTIFICATION.authUpdated) {
        const note = params as HarnessAuthUpdatedNotification | null
        if (!note || typeof note.harness !== 'string' || typeof note.attemptId !== 'string') {
          return true
        }
        const entry = entryOf(note.harness)
        let attempt = entry.attempts.get(note.attemptId)
        if (!attempt) {
          // 应答还没到，进展先到了；或者是别的连接开的登录（那就不管）
          if (!note.providerId && !note.mcpServer) return true
          attempt = {
            attemptId: note.attemptId,
            providerId: note.providerId ?? null,
            mcpServer: note.mcpServer ?? null,
            step: projectStep(note.step),
            forward: null,
            busy: false,
          }
          entry.attempts.set(note.attemptId, attempt)
        }
        advance(entry, attempt, projectStep(note.step))
        return true
      }
      return false
    },

    restarted(harness) {
      const entry = entries.get(harness)
      if (!entry) return
      entry.restartRequired = false
      if (entry.sinks.size > 0) loadAll(entry)
      else entry.stale = true
      emit(entry)
    },

    async write(harness, edits, expectedVersion) {
      const result = await writing(harness, 'config', () =>
        host.request(
          HARNESS_CONFIG_METHOD.configWrite,
          {
            harness,
            edits: edits.map(({ key, value }) => ({ key, value })),
            expectedVersion,
          } as never,
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return {
        overriddenKeys: Array.isArray(result?.overriddenKeys) ? result.overriddenKeys : [],
        restartRequired: result?.restartRequired === true,
      }
    },

    async action(harness, actionId) {
      await writing(harness, 'config', () =>
        host.request(
          HARNESS_CONFIG_METHOD.configAction,
          { harness, actionId },
          { timeoutMs: WAIT_MS },
        ),
      )
    },

    async reload(harness, part) {
      reachable(harness)
      const entry = entryOf(harness)
      if (!part) entry.withModels = true
      await Promise.all((part ? [part] : BASIC).map((one) => load(entry, one)))
    },

    async upsertProvider(harness, providerId, templateId, definition, expectedVersion) {
      const result = await writing(harness, 'providers', () =>
        host.request(
          HARNESS_CONFIG_METHOD.providersUpsert,
          { harness, providerId, templateId, definition, expectedVersion } as never,
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return { restartRequired: result?.restartRequired === true }
    },

    async removeProvider(harness, providerId) {
      const result = await writing(harness, 'providers', () =>
        host.request(
          HARNESS_CONFIG_METHOD.providersRemove,
          { harness, providerId },
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return { restartRequired: result?.restartRequired === true }
    },

    async discoverModels(harness, providerId) {
      reachable(harness)
      let response: { models?: unknown } | undefined
      try {
        response = await host.request(
          HARNESS_CONFIG_METHOD.providersDiscoverModels,
          { harness, providerId },
          { timeoutMs: WAIT_MS },
        )
      } catch (error) {
        throw fail(error)
      }
      const models = Array.isArray(response?.models) ? response.models : []
      return {
        models: models.flatMap((raw) => {
          const one = raw as { id?: unknown; title?: unknown }
          return typeof one.id === 'string' && one.id
            ? [{ id: one.id, title: typeof one.title === 'string' ? one.title : null }]
            : []
        }),
      }
    },

    async activateProvider(harness, providerId, expectedVersion) {
      const result = await writing(harness, 'providers', () =>
        host.request(
          HARNESS_CONFIG_METHOD.providersActivate,
          { harness, providerId, expectedVersion },
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return { restartRequired: result?.restartRequired === true }
    },

    async startAuth(harness, providerId, methodId, inputs) {
      reachable(harness)
      let response: HarnessAuthStartResponse
      try {
        response = await host.request(
          HARNESS_CONFIG_METHOD.authStart,
          { harness, providerId, methodId, ...(inputs ? { inputs } : {}) },
          { timeoutMs: WAIT_MS },
        )
      } catch (error) {
        throw fail(error)
      }
      return adopt(harness, response, { providerId, mcpServer: null })
    },

    async continueAuth(harness, attemptId, inputs) {
      reachable(harness)
      const entry = entryOf(harness)
      const attempt = attemptOf(harness, attemptId)
      attempt.busy = true
      emit(entry)
      try {
        const step = await host.request(
          HARNESS_CONFIG_METHOD.authContinue,
          { harness, attemptId, inputs },
          { timeoutMs: WAIT_MS },
        )
        advance(entry, attempt, projectStep(step))
      } catch (error) {
        attempt.busy = false
        emit(entry)
        throw fail(error)
      }
    },

    async cancelAuth(harness, attemptId) {
      const entry = entryOf(harness)
      const attempt = attemptOf(harness, attemptId)
      if (host.online()) {
        try {
          await host.request(HARNESS_CONFIG_METHOD.authCancel, { harness, attemptId })
        } catch (error) {
          // 对面已经忘了这次登录：这边照样拿掉
          const failed = fail(error)
          if (failed.code !== 'notFound') throw failed
        }
      }
      entry.attempts.delete(attempt.attemptId)
      emit(entry)
    },

    dismissAuth(harness, attemptId) {
      const entry = entries.get(harness)
      if (!entry?.attempts.delete(attemptId)) return
      emit(entry)
    },

    async logout(harness, providerId) {
      await writing(harness, 'providers', () =>
        host.request(
          HARNESS_CONFIG_METHOD.authLogout,
          { harness, providerId },
          { timeoutMs: WAIT_MS },
        ),
      )
    },

    async setEnv(harness, name, value) {
      reachable(harness)
      return setEnvVar(harness, name, value, 0)
    },

    async upsertMcp(harness, server, previousName, expectedVersion) {
      const result = await writing(harness, 'mcp', () =>
        host.request(
          HARNESS_CONFIG_METHOD.mcpUpsert,
          {
            harness,
            server: outgoingMcp(server),
            expectedVersion,
            ...(previousName && previousName !== server.name ? { previousName } : {}),
          },
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return { restartRequired: result?.restartRequired === true }
    },

    async removeMcp(harness, name, expectedVersion) {
      const result = await writing(harness, 'mcp', () =>
        host.request(
          HARNESS_CONFIG_METHOD.mcpRemove,
          { harness, name, expectedVersion },
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return { restartRequired: result?.restartRequired === true }
    },

    async loginMcp(harness, name) {
      reachable(harness)
      let response: HarnessAuthStartResponse
      try {
        response = await host.request(
          HARNESS_CONFIG_METHOD.mcpLogin,
          { harness, name },
          { timeoutMs: WAIT_MS },
        )
      } catch (error) {
        throw fail(error)
      }
      return adopt(harness, response, { providerId: null, mcpServer: name })
    },

    async writeInstructions(harness, content, expectedHash) {
      const result = await writing(harness, 'instructions', () =>
        host.request(HARNESS_CONFIG_METHOD.instructionsWrite, { harness, content, expectedHash }),
      )
      // 统一模式下写的是同一份：别的 harness 开着的也重读
      reloadInstructions()
      return String(result?.hash ?? '')
    },

    async writeModels(harness, entries, expectedVersion) {
      if (entries !== null && entries.length === 0) {
        throw new ChannelError('invalid', '模型清单不能为空。如需使用内置清单，请恢复默认')
      }
      const result = await writing(harness, 'models', () =>
        host.request(
          HARNESS_CONFIG_METHOD.modelsWrite,
          {
            harness,
            entries: entries === null ? null : outgoingModels(entries),
            expectedVersion,
          },
          { timeoutMs: WAIT_MS },
        ),
      )
      needsRestart(harness, result?.restartRequired === true)
      return { restartRequired: result?.restartRequired === true }
    },

    overview,

    async unify(harness, content) {
      const seen = await overview()
      const source = seen.entries.find((entry) => entry.harness === harness)?.info
      if (!source) throw new ChannelError('notFound', `无法读取 ${host.nameOf(harness)} 的指令文件`)
      const linkPaths = seen.entries.flatMap((entry) =>
        entry.harness !== harness && entry.info && entry.info.path !== source.path
          ? [entry.info.path]
          : [],
      )
      try {
        const result = await host.request(
          HARNESS_CONFIG_METHOD.instructionsUnify,
          { sourcePath: source.path, content, linkPaths },
          { timeoutMs: WAIT_MS },
        )
        return (Array.isArray(result?.results) ? result.results : []).map((one) => ({
          path: String(one.path),
          outcome: one.outcome,
          backup: one.backup ?? null,
        }))
      } catch (error) {
        throw fail(error)
      } finally {
        reloadInstructions()
      }
    },

    async separate() {
      const seen = await overview()
      if (!seen.unified) return []
      const { sourcePath } = seen.unified
      const linkPaths = seen.entries.flatMap((entry) =>
        entry.info?.linkTarget === sourcePath ? [entry.info.path] : [],
      )
      try {
        const result = await host.request(
          HARNESS_CONFIG_METHOD.instructionsSeparate,
          { sourcePath, linkPaths },
          { timeoutMs: WAIT_MS },
        )
        return Array.isArray(result?.separated) ? result.separated.map(String) : []
      } catch (error) {
        throw fail(error)
      } finally {
        reloadInstructions()
      }
    },
  }

  /** 写设备设置里这个 harness 的环境变量表。别处先改过了（版本对不上）就重读再写一次 */
  async function setEnvVar(
    harness: string,
    name: string,
    value: string | null,
    tries: number,
  ): Promise<{ restartRequired: boolean }> {
    let raw: Awaited<ReturnType<typeof host.request<'litch/device/settings/read'>>>
    try {
      raw = await host.request('litch/device/settings/read', {})
    } catch (error) {
      throw host.fail(error)
    }
    const manage = projectManage(host.deviceId, raw)
    // 认的是“这个 harness 的、环境变量表类型的那一项”，不认键名
    const spec = manage.settings.find(
      (one) => one.type === 'env' && one.scope.kind === 'harness' && one.scope.harness === harness,
    )
    if (!spec) {
      throw new ChannelError('unsupported', `设备设置中没有 ${host.nameOf(harness)} 的环境变量`)
    }
    const current = manage.snapshot.values[spec.key]
    const table: EnvEntryView[] = (Array.isArray(current) ? current : [])
      .filter((entry) => entry.name !== name)
      // 别的密钥不带值：设备那边保留原来的
      .map((entry) => (entry.secret ? { name: entry.name, secret: true } : entry))
    if (value !== null) table.push({ name, value, secret: true })
    try {
      const result = await host.request(
        'litch/device/settings/write',
        {
          expectedVersion: manage.snapshot.version,
          edits: outgoingEdits([{ key: spec.key, value: table }]),
        },
        { timeoutMs: WAIT_MS },
      )
      const restarted = Array.isArray(result?.restarted) && result.restarted.includes(harness)
      const pending =
        Array.isArray(result?.snapshot?.pendingRestart) &&
        result.snapshot.pendingRestart.includes(harness)
      const entry = entryOf(harness)
      // 设备顺手把它重启了：读得到新的环境变量了，provider 的状态重读
      if (restarted) void load(entry, 'providers')
      needsRestart(harness, pending)
      return { restartRequired: pending }
    } catch (error) {
      const failed = host.fail(error)
      if (failed.code === 'conflict' && tries < 2) return setEnvVar(harness, name, value, tries + 1)
      throw failed
    }
  }
}

/**
 * 现在是不是统一模式：读得到的各份里，除了一份真文件，其余（至少一份）都是指向同一个地方的软链。
 * 软链指向的那份不在读得到的里面（它的 harness 没在跑）也算，这时说不出是哪个 harness 的
 */
export function unifiedOf(
  entries: InstructionsOverview['entries'],
): InstructionsOverview['unified'] {
  const infos = entries.flatMap((entry) =>
    entry.info ? [{ harness: entry.harness, info: entry.info }] : [],
  )
  const links = infos.filter((one) => one.info.linkTarget !== null)
  if (links.length === 0) return null
  const target = links[0]?.info.linkTarget ?? null
  if (target === null || links.some((one) => one.info.linkTarget !== target)) return null
  const real = infos.filter((one) => one.info.linkTarget === null && one.info.exists)
  // 还有别的真文件、不是那份的：只是有一份碰巧是软链，不是统一模式
  if (real.some((one) => one.info.path !== target)) return null
  return {
    sourcePath: target,
    harness: real.find((one) => one.info.path === target)?.harness ?? null,
  }
}
