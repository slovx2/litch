// 设备进程的主体：一台机器上的多个 harness 运行时收在一个入口（聚合面）后面。
// 这里只管各条客户端连接共用的东西；一条连接上的事在 session.mts。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_TASKS_NOTIFICATION } from '../../protocol/src/background-tasks.mjs'
import { CLIENT_TOOL_NAMESPACE } from '../../protocol/src/client-tools.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import { HARNESS_INSTALL_NOTIFICATION } from '../../protocol/src/device-harness-install.mjs'
import type { DeviceSettingsSnapshot } from '../../protocol/src/device-settings.mjs'
import { HARNESS_CONFIG_NOTIFICATION } from '../../protocol/src/harness-config.mjs'
import { taskCardsSettingKey } from '../../protocol/src/session-tree.mjs'
import { WORKTREE_DEFAULTS, WORKTREE_SETTING } from '../../protocol/src/worktrees.mjs'
import { PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { DeviceApprovals } from './approvals.mjs'
import { DeviceBackground } from './background.mjs'
import { ClientToolInvoker } from './client-tool-invoke.mjs'
import { ClientToolRouter } from './client-tools.mjs'
import { CodexTitles } from './codex-titles.mjs'
import type { ControlChannel, ControlState } from './control.mjs'
import { DeviceLayer } from './device-layer.mjs'
import type { ProcessLimits } from './device-processes.mjs'
import { DeviceTools } from './device-tools.mjs'
import { connectEngineLink, type EngineLink, EngineUnavailable } from './engine-link.mjs'
import type { FlowLimits } from './flow.mjs'
import { deviceInfo, deviceVersion, HarnessCatalog } from './harness-info.mjs'
import { WorkspaceImporter } from './importer.mjs'
import { DeviceManagement } from './management.mjs'
import { dialectFor } from './native-codex.mjs'
import { DevicePairing, type PairingConfig } from './pairing.mjs'
import { hasActiveTurn } from './probe.mjs'
import { ACTIVITY_METHOD, type DeviceActivity, serviceInfo } from './service-info.mjs'
import {
  ClientSession,
  type HarnessSource,
  type SessionHost,
  type SessionTiming,
  type UpstreamConfig,
} from './session.mjs'
import { SessionArchives } from './session-archive.mjs'
import { openSessionDatabase, SessionStore } from './session-store.mjs'
import { sessionToolsHandler } from './session-tools.mjs'
import { SessionTree } from './session-tree.mjs'
import { openDeviceStore } from './store.mjs'
import { DEFAULT_TASK_TIMING, type TaskTiming } from './task-run.mjs'
import { DEFAULT_TASK_SETTINGS, type TaskClock, type TaskSettings } from './task-scheduler.mjs'
import { DeviceTasks } from './tasks.mjs'
import { registerTasksTool } from './tasks-tool.mjs'
import { ThreadIndex } from './thread-index.mjs'
import { type Connector, isObject, type Wire, type WireHandlers } from './wire.mjs'
import { Workspaces } from './workspaces.mjs'
import { gitVersion } from './worktree-git.mjs'
import { WorktreeLife } from './worktree-life.mjs'
import { openWorktreeDatabase, type WorktreeSettings, Worktrees } from './worktrees.mjs'

/** 记一条结构化的摘要：事件名和少量字段（不带正文、内容、密钥） */
export type DeviceTrace = (
  event: string,
  fields: Record<string, unknown>,
  level?: 'info' | 'warn' | 'error',
) => void

export interface DeviceOptions {
  /** 设备进程自己的状态目录，设备库 device.sqlite 放在里面 */
  stateDir: string
  /**
   * 设备级的工作区第一次启用时，要不要从各引擎现有的项目导入。
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
  /** 结构化的摘要（logs/device.jsonl）：连接、每个客户端请求的成败和耗时。不给就不记 */
  trace?: DeviceTrace
  /** 定时任务的时钟和时限。只有测试会改 */
  tasks?: { clock?: TaskClock; timing?: Partial<TaskTiming>; maxTimerMs?: number }
  /** 内部连接替引擎看着没人拿的请求：先等多久、隔多久再看（毫秒），见 engine-link.mts。只有测试会改 */
  engineLinks?: { heldGraceMs?: number; heldRecheckMs?: number }
  /**
   * 扫码绑定手机（devicePairing）：钥匙文件、主机钥匙、适配器命令行在哪。main.mts 按这台机器给；
   * 不给就没有这项扩展，也不碰任何钥匙文件（和配对无关的测试都不给）
   */
  pairing?: PairingConfig
  /** 没有主进程在管设置时要不要每回合收尾（设置键 sessions.wrapUp），缺省要。只有夹具会关 */
  wrapUp?: boolean
  /** 没有主进程在管设置时提不提醒收尾（设置键 sessions.wrapUpReminder），缺省提醒。只有夹具会关 */
  wrapUpReminder?: boolean
}

/**
 * 有主进程在管时，等它把设置送过来再开始排定时任务，最多等这么久（毫秒）：
 * 总开关关着的话，刚起来就不该把错过的补跑了
 */
const TASK_SETTINGS_WAIT_MS = 10_000
/** 主进程跑一次 `codex debug models --bundled` 最多等多久（它那边自己等 20 秒） */
const CODEX_CATALOG_TIMEOUT_MS = 30_000

/** 主进程推来的定时任务设置（settings_tasks.go）。没有、不成样子的项用默认值 */
export function taskSettings(state: ControlState | null): TaskSettings {
  const given = state?.tasks
  const settings = { ...DEFAULT_TASK_SETTINGS }
  if (isObject(given)) {
    if (typeof given.enabled === 'boolean') settings.enabled = given.enabled
    if (Number.isInteger(given.maxConcurrent) && (given.maxConcurrent as number) >= 1)
      settings.maxConcurrent = given.maxConcurrent as number
    if (
      Number.isInteger(given.approvalTimeoutMinutes) &&
      (given.approvalTimeoutMinutes as number) >= 1
    )
      settings.approvalTimeoutMinutes = given.approvalTimeoutMinutes as number
  }
  return settings
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
  // 子会话里的审批、提问挂了这么久没人答，算它停下来在等用户（会话树的唤醒看它）
  needsUserMs: 10_000,
  // 父会话最后一个回合结束超过这么久，子会话的回报不再主动唤醒它，等用户发话或“立即处理”
  wakeIdleMs: 24 * 3600_000,
  // 会话树为读设置、开提醒或唤醒回合订阅的会话，用不着了隔这么久退订：原生 codex 只卸载没人订阅的会话，
  // 卸载了才放开写入锁，ChatGPT.app 等别的应用才打得开
  releaseMs: 5000,
}

/** 设备设置里的工作树那一组（Go 层 settings_worktrees.go 声明）。没写、写坏了的用默认值；根目录默认在状态目录下 */
export function worktreeSettings(
  values: Record<string, unknown> | undefined,
  stateDir: string,
): WorktreeSettings {
  const root = values?.[WORKTREE_SETTING.root]
  const prefix = values?.[WORKTREE_SETTING.branchPrefix]
  const fetch = values?.[WORKTREE_SETTING.fetchFirst]
  const clean = values?.[WORKTREE_SETTING.autoCleanup]
  const count = (key: string, fallback: number, least: number, most: number) => {
    const value = values?.[key]
    return typeof value === 'number' && Number.isInteger(value) && value >= least && value <= most
      ? value
      : fallback
  }
  return {
    root: typeof root === 'string' && root.trim() ? root.trim() : join(stateDir, 'worktrees'),
    branchPrefix: typeof prefix === 'string' ? prefix.trim() : WORKTREE_DEFAULTS.branchPrefix,
    fetchFirst: typeof fetch === 'boolean' ? fetch : WORKTREE_DEFAULTS.fetchFirst,
    autoCleanup: typeof clean === 'boolean' ? clean : WORKTREE_DEFAULTS.autoCleanup,
    keepCount: count(WORKTREE_SETTING.keepCount, WORKTREE_DEFAULTS.keepCount, 1, 200),
    keptDays: count(WORKTREE_SETTING.keptDays, WORKTREE_DEFAULTS.keptDays, 7, 365),
  }
}

/**
 * 设置里“会话编排”的开关（Go 层的 settings_sessions.go 声明）。没有主进程在管（没有设置功能）时按开着算
 */
export const SESSION_TREE_SETTING = 'sessions.enabled'

/**
 * 设置里“每回合收尾”的总开关（同在 settings_sessions.go）：开着时新会话的 litch_sessions 带 wrap_up，规则要求
 * 每回合先收尾再写最终回答；关掉时新会话不带 wrap_up、规则里不提收尾，也不提醒。没有主进程在管时看
 * DeviceOptions.wrapUp，缺省开着
 */
export const WRAP_UP_SETTING = 'sessions.wrapUp'

/**
 * 设置里“提醒收尾”的开关（同在 settings_sessions.go）：用户发起的回合结束时模型没调 litch_sessions.wrap_up，
 * 替它开一个回合提醒。没有主进程在管时看 DeviceOptions.wrapUpReminder，缺省开着
 */
export const WRAP_UP_REMINDER_SETTING = 'sessions.wrapUpReminder'

export class DeviceServer {
  private readonly host: SessionHost
  private readonly sessions = new Set<ClientSession>()
  private readonly db: DatabaseSync
  /** 会话树的库（sessions.sqlite），带迁移，和 device.sqlite 分开 */
  private readonly sessionsDb: DatabaseSync
  private readonly index: ThreadIndex
  private readonly workspaces: Workspaces
  private readonly importer: WorkspaceImporter | null
  private readonly layer: DeviceLayer
  private readonly options: DeviceOptions
  private readonly control: ControlChannel | null
  private readonly version: string
  /** 定时任务。任务库打不开时是 null */
  private readonly tasks: DeviceTasks | null
  private tasksWait: NodeJS.Timeout | null = null
  private readonly taskTiming: TaskTiming
  /** 设备进程自己开着的引擎连接：设备进程关的时候一起关 */
  private readonly engineLinks = new Set<EngineLink>()
  /** 主进程给的名单里的 harness 怎么连，按套接字地址记着 */
  private readonly dialed = new Map<string, Connector>()
  /** 上一次发给客户端的设置快照（起步时是主进程给的第一份现状），用来判断是不是真的变了 */
  private lastSnapshot: string | null = null
  /** 有几次写入正在进行。大于 0 时设置变化的通知先攒着，见 holdSettings */
  private settling = 0
  /** 还没告诉客户端的那些变化动过的设置键 */
  private readonly unannounced = new Set<string>()
  private closed = false
  /** 由设备进程自己执行的 litch_ 命名空间（litch_tasks、litch_sessions），见 device-tools.mts */
  readonly deviceTools: DeviceTools
  /** 会话树：父子关系、提案、回报与唤醒（session-tree.mts） */
  readonly sessionTree: SessionTree
  /** 原生 codex 会话的自动起名 */
  readonly titles: CodexTitles
  /** 每个会话的后台任务（backgroundTasks 扩展） */
  readonly background: DeviceBackground
  /** 上一次看到的“会话编排”开关，变了才动 */
  private orchestrating: boolean
  /** 扫码绑定手机。没给配置时是 null */
  private readonly pairing: DevicePairing | null
  /** 手机上批准：桌面端挂的卡片（只在内存） */
  private readonly approvals: DeviceApprovals
  /** 设备层的工作树。这台机器上没有 git 时是 null */
  readonly worktrees: Worktrees | null
  readonly worktreeLife: WorktreeLife | null
  readonly archives: SessionArchives
  private readonly worktreesDb: DatabaseSync | null

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
    this.background = new DeviceBackground({
      announce: (method, params, extension) => this.announce(method, params, extension),
    })
    const info = deviceInfo(this.version)
    // 设置功能要有适配器主进程在管才有：客户端看这份列表决定出不出设置界面
    if (this.control) info.extensions.push(EXTENSION.deviceSettings)
    // 服务的来历也是主进程给的：有它在管，声明过的客户端才问得到“在跑的是哪一份”
    if (this.control) info.extensions.push(EXTENSION.deviceService)
    // 给设备装 harness：装的事在主进程里做（登记表、用户的环境、装完重启它），也是有它在管才有
    if (this.control) info.extensions.push(EXTENSION.harnessInstall)
    // 可重连的终端：进程可以属于设备
    info.extensions.push(EXTENSION.deviceProcesses)
    // harness 详情设置：统一模式（只是文件操作）由设备进程做，原生 codex 的 litch/harness/* 由设备进程替它翻译。
    // 各引擎自己支不支持看它们各自的声明
    info.extensions.push(EXTENSION.harnessConfig)
    const log = options.log ?? (() => {})
    // 扫码绑定手机：一起来就清掉上次留下的一次性钥匙行；拿不到适配器命令行、Windows 管理员账号时不列这项扩展
    this.pairing = options.pairing
      ? new DevicePairing(options.pairing, {
          announce: (method, params, extension) => this.announce(method, params, extension),
          log,
        })
      : null
    if (this.pairing?.available) info.extensions.push(EXTENSION.devicePairing)
    // 手机上批准只是转交，设备上什么都不要
    this.approvals = new DeviceApprovals({
      announce: (method, params, extension) => this.announce(method, params, extension),
      log,
    })
    info.extensions.push(EXTENSION.clientApprovals)
    const taskTiming = { ...DEFAULT_TASK_TIMING, ...options.tasks?.timing }
    this.taskTiming = taskTiming
    this.deviceTools = new DeviceTools(log)
    // litch_tasks 是第一个注册者：调用从哪条连接来都由设备进程答
    registerTasksTool(this.deviceTools, {
      tasks: () => this.tasks,
      workspaces: this.workspaces,
      openEngineLink: (harness) => this.openEngineLink(harness),
    })
    this.tasks = DeviceTasks.open({
      stateDir: options.stateDir,
      harnesses: () => this.harnesses(),
      index: this.index,
      workspaces: this.workspaces,
      announce: (method, params, extension) => this.announce(method, params, extension),
      log,
      version: this.version,
      timing: taskTiming,
      // 对准已有会话的任务回合：带上排着的子会话回报，开始结束告诉会话树（决 657）
      turnHooks: {
        input: (threadId, input) => this.sessionTree.beforeDeviceTurn(threadId, input),
        started: (harness, threadId, turnId) =>
          this.sessionTree.turnEvent(harness, 'turn/started', { threadId, turn: { id: turnId } }),
        ended: (harness, threadId, turnId, status) =>
          this.sessionTree.turnEvent(harness, 'turn/completed', {
            threadId,
            turn: { id: turnId, status: status === 'timedOut' ? 'interrupted' : status },
          }),
      },
      ...(options.tasks?.clock ? { clock: options.tasks.clock } : {}),
      ...(options.tasks?.maxTimerMs ? { maxTimerMs: options.tasks.maxTimerMs } : {}),
      // harness 正在起（比如服务刚重启、错过的运行正要补跑）时等它一会儿
      openEngineLink: (harness) =>
        this.openEngineLink(harness, { waitMs: taskTiming.harnessWaitMs }),
      backgroundRunning: (threadId) => this.background.running(threadId),
      backgroundWakes: (threadId) => this.background.wakes(threadId),
      // 工作树在下面才建好，用的时候再取
      worktrees: () => this.worktrees,
    })
    // 定时任务：任务存在设备上，到点由设备进程自己连上 harness 去跑
    if (this.tasks) info.extensions.push(EXTENSION.deviceTasks)
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
      // 安装任务的进度：只发给握手时声明了 harnessInstall 的连接
      this.control.onInstall = (job) =>
        this.announce(HARNESS_INSTALL_NOTIFICATION.changed, job, EXTENSION.harnessInstall)
    }
    this.sessionsDb = openSessionDatabase(options.stateDir)
    // 工作树：要有 git 才列这项扩展
    this.worktreesDb = gitVersion() ? openWorktreeDatabase(options.stateDir) : null
    this.worktrees = this.worktreesDb
      ? new Worktrees(this.worktreesDb, {
          settings: () => this.worktreeSettings(),
          announce: (method, params, extension) => this.announce(method, params, extension),
          log,
        })
      : null
    if (this.worktrees) info.extensions.push(EXTENSION.worktrees)
    this.orchestrating = this.sessionTreeOn()
    this.sessionTree = new SessionTree({
      harnesses: () => this.harnesses(),
      openEngineLink: (harness) => this.openEngineLink(harness),
      index: this.index,
      workspaces: this.workspaces,
      store: new SessionStore(this.sessionsDb),
      worktrees: this.worktrees,
      enabled: () => this.sessionTreeOn(),
      announce: (method, params, extension) => this.announce(method, params, extension),
      threadStarted: (harness, thread) => {
        for (const session of this.sessions) session.threadStarted(harness, thread)
      },
      timeoutMs: options.timing?.listTimeoutMs ?? DEFAULT_TIMING.listTimeoutMs,
      needsUserMs: options.timing?.needsUserMs ?? DEFAULT_TIMING.needsUserMs,
      wakeIdleMs: options.timing?.wakeIdleMs ?? DEFAULT_TIMING.wakeIdleMs,
      releaseMs: options.timing?.releaseMs ?? DEFAULT_TIMING.releaseMs,
      taskTurn: (threadId, turnId) => this.tasks?.isTaskTurn(threadId, turnId) ?? false,
      backgroundRunning: (threadId) => this.background.running(threadId),
      backgroundTasks: (threadId) => this.background.tasks(threadId),
      backgroundWakes: (threadId) => this.background.wakes(threadId),
      wrapUp: () => {
        const value = this.control?.state?.snapshot.values[WRAP_UP_SETTING]
        return this.control ? value !== false : options.wrapUp !== false
      },
      wrapUpReminder: () => {
        const value = this.control?.state?.snapshot.values[WRAP_UP_REMINDER_SETTING]
        return this.control ? value !== false : options.wrapUpReminder !== false
      },
      // 任务卡按 harness 的开关（settings_sessions.go 的 taskCardsSetting）：没写过、没有主进程在管都按开着算
      taskCards: (harness) =>
        this.control?.state?.snapshot.values[taskCardsSettingKey(harness)] !== false,
      log,
    })
    // 以前删会话时没删它带的动态工具（每个几十 KB）：设备不认识的会话的那一行清一次。
    // 索引是空的（device.sqlite 刚建、刚换过）时分不出哪些会话还在，留到下次启动
    const sessionStore = this.sessionTree.store
    if (sessionStore.chore('pruneThreadTools') && !this.index.empty()) {
      const dropped = sessionStore.pruneTools((threadId) => this.index.lookup(threadId) !== null)
      sessionStore.choreDone('pruneThreadTools')
      if (dropped > 0) log(`清掉了 ${dropped} 个已删会话留下的动态工具`)
    }
    // 归档时子会话跟着走、模型的 litch_sessions.archive（session-archive.mts）
    this.archives = new SessionArchives({
      tree: this.sessionTree,
      worktreeLife: () => this.worktreeLife,
      pinned: (threadId) =>
        this.workspaces.sections.placement(threadId)?.section.id === PINNED_SECTION_ID,
      shelved: (threadId, archived) => {
        for (const session of this.sessions) session.threadShelved(threadId, archived)
      },
      log,
    })
    this.deviceTools.register(
      CLIENT_TOOL_NAMESPACE.sessions,
      sessionToolsHandler(this.sessionTree, this.archives),
    )
    // 工作树跟着会话的归档、删除、重新打开走，定时清理（worktree-life.mts）
    this.worktreeLife = this.worktrees
      ? new WorktreeLife(this.worktrees, {
          known: (threadId) => this.index.recent(threadId),
          pinned: (threadId) =>
            this.workspaces.sections.placement(threadId)?.section.id === PINNED_SECTION_ID,
          running: (threadId) => this.sessionTree.isActive(threadId),
          roots: () =>
            this.workspaces.projects
              .list()
              .flatMap((project) => project.roots.map((root) => root.path)),
          log,
        })
      : null
    this.worktreeLife?.start()
    // 不等客户端连上：在跑的子会话重新盯上、排着的回报看看要不要唤醒（没人连着也唤醒，决 660）
    this.sessionTree.started()
    // 子会话的后台任务跑完了：引擎不会接着做的，会话树补一条回报（决 430）
    this.background.onSettled((threadId, tasks) =>
      this.sessionTree.backgroundSettled(threadId, tasks),
    )
    // 有后台任务在跑的会话：设备进程的连接跟着它，跑完以后引擎自己续跑的回合里调设备工具（收尾、任务卡）有执行方
    this.background.onBusy((threadId) => this.sessionTree.follow(threadId))
    this.titles = new CodexTitles({
      openEngineLink: (harness) => this.openEngineLink(harness),
      store: this.sessionTree.store,
      log,
    })
    const router = new ClientToolRouter({
      graceMs: options.timing?.clientToolGraceMs ?? DEFAULT_TIMING.clientToolGraceMs,
      log,
    })
    this.host = {
      ...(options.trace ? { trace: options.trace } : {}),
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
      closed: (session) => {
        this.sessions.delete(session)
        this.sessionTree.clientLeft(
          this.harnesses()
            .filter((source) => !source.managed || source.managed.state === 'running')
            .map((source) => source.id),
        )
      },
      clientTools: router,
      clientInvoke: new ClientToolInvoker({ router, index: this.index, log }),
      tasks: this.tasks,
      deviceTools: this.deviceTools,
      sessionTree: this.sessionTree,
      sessionTreeOn: () => this.sessionTreeOn(),
      pairing: this.pairing,
      approvals: this.approvals,
      harnessConfigChanged: (params) =>
        this.announce(HARNESS_CONFIG_NOTIFICATION.changed, params, EXTENSION.harnessConfig),
      harnessEnvNames: (harness) => this.harnessEnvNames(harness),
      titles: this.titles,
      background: this.background,
      worktrees: this.worktrees,
      worktreeLife: this.worktreeLife,
      archives: this.archives,
      codexCatalog: () =>
        this.control
          ? this.control.request('codex.models', {}, CODEX_CATALOG_TIMEOUT_MS)
          : Promise.reject(new Error('没有主进程，问不到 codex 自带的模型目录')),
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
    if (!this.control) this.tasks?.begin()
    else if (this.control.state) this.tasks?.begin(taskSettings(this.control.state))
    else if (this.tasks) {
      this.tasksWait = setTimeout(() => {
        log('适配器主进程一直没有送来设置，定时任务按默认的设置开始')
        this.tasks?.begin()
      }, TASK_SETTINGS_WAIT_MS)
      this.tasksWait.unref()
    }
  }

  /**
   * 设备层的数据变了：告诉所有聚合面连接，发起变更的那条也收，和引擎里的做法一样。
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

  /** 设备设置里 `harness.<id>.env` 填了哪些变量名（值是密钥的读不到，名字够了） */
  private harnessEnvNames(harness: string): string[] {
    const entries = this.control?.state?.snapshot.values[`harness.${harness}.env`]
    if (!Array.isArray(entries)) return []
    return entries.flatMap((entry) => (typeof entry?.name === 'string' ? [entry.name] : []))
  }

  /** 设置里“会话编排”开着没有。没有设置功能（没有主进程在管）时按开着算 */
  private worktreeSettings(): WorktreeSettings {
    return worktreeSettings(this.control?.state?.snapshot.values, this.options.stateDir)
  }

  private sessionTreeOn(): boolean {
    return this.control?.state?.snapshot.values[SESSION_TREE_SETTING] !== false
  }

  /** 主进程推来了新的状态：各条连接跟着调整上游，设置真的变了就通知声明过的客户端 */
  private controlChanged(state: ControlState): void {
    this.applyProcessLimits(state)
    if (this.tasksWait) clearTimeout(this.tasksWait)
    this.tasksWait = null
    this.tasks?.setSettings(taskSettings(state))
    const orchestrating = this.sessionTreeOn()
    // 会话编排刚打开：关着时攒下的回报现在可以唤醒了
    if (orchestrating && !this.orchestrating) this.sessionTree.checkAll()
    this.orchestrating = orchestrating
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

  /** 这个 harness 是不是有回合在跑。判断不了的时候返回 true，宁可不重启也不打断回合 */
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
      tasks: this.tasks?.running ?? 0,
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

  /**
   * 设备进程自己开一条到某个 harness 的连接（不对应任何客户端连接），握手完成才返回。
   * harness 没配、不在 running、连不上抛 EngineUnavailable（code 是 harnessUnavailable）。
   * waitMs：它正在起、暂时连不上时最多等多久，默认不等。用完调 close；设备进程关的时候一起关掉
   */
  async openEngineLink(harness: string, options: { waitMs?: number } = {}): Promise<EngineLink> {
    const deadline = Date.now() + (options.waitMs ?? 0)
    for (;;) {
      if (this.closed) throw new EngineUnavailable(harness, 'the device service is shutting down')
      const source = this.harnesses().find((item) => item.id === harness)
      if (!source)
        throw new EngineUnavailable(
          harness,
          `${harness} is not configured on this device`,
          'unknownHarness',
        )
      const state = source.managed?.state
      if (state && state !== 'running' && state !== 'starting')
        throw new EngineUnavailable(harness, `${harness} is not running (${state})`)
      let failure: EngineUnavailable | null = null
      if (state === 'starting')
        failure = new EngineUnavailable(harness, `${harness} is still starting`)
      else
        try {
          return this.keep(
            await connectEngineLink({
              harness,
              connect: source.connect,
              dialect: dialectFor(source.managed ? source.managed.native : source.native),
              version: this.version,
              handshakeTimeoutMs: this.taskTiming.handshakeTimeoutMs,
              requestTimeoutMs: this.taskTiming.requestTimeoutMs,
              tools: this.deviceTools,
              instructions: this.sessionTree.store,
              speeds: this.sessionTree.store,
              log: (line) => this.options.log?.(`[${harness}] ${line}`),
              ...this.options.engineLinks,
              // 真正的客户端拿着，或者设备进程的另一条连接接过去了（定时任务回合里的审批）
              held: (from, requestId) =>
                [...this.sessions].some((session) => session.holdsServerRequest(from, requestId)) ||
                [...this.engineLinks].some(
                  (link) => link.harness === from && link.claimed(requestId),
                ),
            }),
          )
        } catch (error) {
          failure =
            error instanceof EngineUnavailable
              ? error
              : new EngineUnavailable(harness, String(error))
        }
      if (Date.now() >= deadline) throw failure
      await new Promise((resolve) => setTimeout(resolve, 1000).unref())
    }
  }

  private keep(link: EngineLink): EngineLink {
    if (this.closed) {
      link.close()
      throw new EngineUnavailable(link.harness, 'the device service is shutting down')
    }
    this.engineLinks.add(link)
    link.onClose(() => this.engineLinks.delete(link))
    // 设备进程自己的连接上看到的也算：没有客户端连着时跑的定时任务、子会话，回报里也要数得出后台任务
    link.onNotification((method, params) => {
      if (!params || typeof params !== 'object') return
      if (method === BACKGROUND_TASKS_NOTIFICATION.changed) this.background.reportedChanged(params)
      else if (link.native) this.background.codexNotification(method, params)
    })
    return link
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
    if (this.tasksWait) clearTimeout(this.tasksWait)
    // 先停任务、关内部连接：等着的回合当场醒来，运行留着 running，下次起来去查
    this.tasks?.close()
    this.pairing?.close()
    this.approvals.shutdown()
    for (const link of [...this.engineLinks]) link.close()
    for (const session of [...this.sessions]) session.close()
    this.sessionTree.close()
    this.worktreeLife?.stop()
    this.titles.close()
    this.deviceTools.close()
    await this.importer?.close()
    await this.layer.close()
    this.db.close()
    this.sessionsDb.close()
    this.worktreesDb?.close()
  }
}
