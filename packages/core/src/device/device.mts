// 一台设备：一条连接，加上连上之后要做的事。
// 对面有两种（设计文档 01 第 7.5 节）：
// - 一个普通的 Codex 服务（原生 codex，或适配器的一个入口）：单 harness 模式，这是基础层；
// - 设备服务的聚合面，一条连接里有多个 harness：完整模式，在基础层上多了 harness 这个维度——
//   每个会话记着自己属于哪个 harness；不带会话标识的请求要指明发给哪个；某个 harness 可以单独不可用、
//   单独恢复，恢复之后它的会话列表要补取、它上面打开着的会话要重新订阅。
// 握手之后问一次 runtime/info 来认。对面没声明的扩展连参数都不带（设计文档 03 第十五节）。
// 数据流的纪律见设计文档 01 第十节：通知按白名单路由；连接健康时通知是唯一的数据来源；
// 只在刚连上、重连之后、手动刷新这三个时机做全量对账。

import { clientToolSpecs } from '../../../protocol/src/client-tools-specs.mjs'
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientInfo,
  DEVICE_SETTINGS_CHANGED,
  type DeviceSettingsChangedNotification,
  EXTENSION,
  isUnknownMethodError,
  type Model,
  type ModelListResponse,
  type Project,
  type ProjectListResponse,
  type ServerNotificationMethod,
  type ServerNotifications,
  type Thread,
  type ThreadListSkippedHarness,
} from '../../../protocol/src/index.mjs'
import { ChannelError, type Clock, type SidebarOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { createLink, type LinkState } from '../connection/link.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type { TransportOpener } from '../connection/transport.mjs'
import type {
  ComposeOptions,
  ConnectFailureView,
  ConnectionState,
  DeviceView,
  HarnessAbilities,
  HarnessId,
  HarnessView,
  OutgoingMessage,
  RemoteTarget,
  SessionDefaults,
  SessionSettings,
  SessionSummary,
  SidebarView,
  ToolSwitches,
  WireColor,
  WorkspaceView,
} from '../model.mjs'
import type { ToolInvocation } from '../model-client-tools.mjs'
import type {
  DiagnosticsView,
  HarnessRestartResult,
  LogSource,
  LogTailView,
  SettingEditView,
  SettingsWriteResult,
  SshConfigView,
} from '../model-manage.mjs'
import type {
  DeviceServiceView,
  ServiceUpgradeReport,
  ServiceUpgradeView,
} from '../model-service.mjs'
import { phrase, sameText, type Text } from '../phrase.mjs'
import type { RequestChoice } from '../projection/requests.mjs'
import { projectService, projectUpgrade } from '../projection/service.mjs'
import { projectSummary, threadTitle } from '../projection/session.mjs'
import { composeOptions, projectDefaults } from '../projection/settings.mjs'
import type { SkillCatalog } from '../projection/skills.mjs'
import { pathTwin } from '../text/paths.mjs'
import type { ToolHub } from '../tool-hub.mjs'
import { collectThreads, type Listing, mergeListing } from './catalog.mjs'
import { createComposeAids } from './compose.mjs'
import { createDiffs, type Diffs } from './diffs.mjs'
import { channelFailure, listNames } from './faults.mjs'
import { createFiles, type Files } from './files.mjs'
import {
  codexHarness,
  type HarnessTerms,
  harnessFromInfo,
  harnessFromRuntimeInfo,
  isDeviceRuntime,
  stampedHarness,
  termsOf,
} from './harness.mjs'
import { createLiveSessions } from './live.mjs'
import { createManagement } from './manage.mjs'
import { createOrganizer, looseDirectories, type Organizer } from './organize.mjs'
import type { SnapshotStore } from './snapshot.mjs'
import type { TerminalNotesStore } from './terminal-launch.mjs'
import { createTerminals, type Terminals } from './terminals.mjs'
import { clientAskOptions, createToolCalls, type ToolAskPlace } from './tool-calls.mjs'
import { projectWorkspaces, resolveWorkspace } from './workspaces.mjs'

export type { DeviceSnapshot, SnapshotStore } from './snapshot.mjs'

export interface DeviceConfig {
  id: string
  name: Text
  /** 给人看的主机标识 */
  host: string
  kind: 'local' | 'ssh'
  /** 远程设备的连接配置，只用来显示和编辑；真正怎么连在 open 里 */
  target: RemoteTarget | null
  wire: WireColor
  open: TransportOpener
  /**
   * 本机设备：最近一次打开传输时，对“在跑的设备服务和应用自带的是不是同一版”做了什么（外壳给的，
   * 形状见 model-service.mts 的 ServiceUpgradeReport）。每次连上之后核心来取一次，放进设备的显示数据里。
   * 不给，或者返回 null，就是没有这回事：远程设备、另外指定了入口的本机
   */
  upgrade?: () => ServiceUpgradeReport | null
}

export interface DeviceHooks {
  /** 设备的显示数据变了 */
  device(view: DeviceView): void
  /** 侧栏整体换了一份：全量对账之后，或工作区变了之后 */
  sidebar(view: SidebarView): void
  sidebarOps(ops: SidebarOp[]): void
}

export interface DeviceOptions {
  clock: Clock
  clientInfo: ClientInfo
  hooks: DeviceHooks
  snapshot?: SnapshotStore
  /** 终端的两样记在这台电脑上的东西（改过的名字、留在设备上不看的）存在哪。不给就不记 */
  terminalNotes?: TerminalNotesStore
  /** 通往主进程的客户端工具那一头（tool-hub.mts）。不给就是这台桌面什么都执行不了 */
  tools?: ToolHub
  /** 这台设备的两个开关现在是什么（决 190）。不给按默认：浏览器开、Computer Use 关 */
  toolSwitches?(): { browser: boolean; computer: boolean }
  log?(line: string): void
}

/** 设备设置页上两个开关的默认值（决 190） */
export const DEFAULT_TOOL_SWITCHES = { browser: true, computer: false } as const

/** 给执行器的 ssh 目标：别名原样；主机写成 user@host，带端口时用 ssh 认的 ssh://user@host:端口 */
const sshTarget = (target: RemoteTarget | null): string | null => {
  if (!target) return null
  if (target.kind === 'alias') return target.alias
  const at = target.user ? `${target.user}@${target.host}` : target.host
  return target.port ? `ssh://${at}:${target.port}` : at
}

export interface Device {
  readonly view: DeviceView
  readonly sidebar: SidebarView
  readonly online: boolean
  start(): void
  stop(): void
  /** 立刻重连。连着的时候是丢掉现在这条连接、从头再连一次 */
  retry(): void
  /** 改显示名、线色。怎么连不在这里改：那要换一条连接，由核心重建这台设备 */
  update(patch: { name?: Text; wire?: WireColor }): void
  /** 手动刷新：重新做一次全量对账 */
  refresh(): Promise<void>
  /** 打开一个会话：载入并订阅它。先给快照，之后给增量；返回关闭函数 */
  openSession(sessionId: string, sink: HostSink): () => void
  /**
   * 建一个会话并发出第一条消息，返回会话标识。
   * harness：完整模式下建在哪个 harness 上，不给就用第一个可用的；单 harness 模式下不看它。
   * workspaceId：建在哪个工作区里。对面有工作区这组方法时随请求带过去，会话从一开始就归在那里
   * （不带的话只能按工作目录去认，工作目录在两个工作区里都算得上时会认错）
   */
  create(
    cwd: string | null,
    message: OutgoingMessage,
    settings: Partial<SessionSettings>,
    harness?: HarnessId,
    workspaceId?: string,
  ): Promise<string>
  /** 整理侧栏：工作区的增删改和排序、把会话移到别的工作区、置顶 */
  readonly organize: Organizer
  /** 加工作区时可以直接挑的目录：还没归进任何工作区的会话的工作目录，最近用过的在前 */
  rootCandidates(): string[]
  configure(sessionId: string, settings: Partial<SessionSettings>): void
  /** 执行计划：退出计划模式，并以 text 这句话发起一个回合 */
  implementPlan(sessionId: string, text: string): Promise<void>
  rename(sessionId: string, title: string): Promise<void>
  /** 归档：从列表里收起来，内容还在设备上 */
  archive(sessionId: string): Promise<void>
  /** 把归档了的会话放回列表里 */
  unarchive(sessionId: string): Promise<void>
  /** 删除：设备上的会话记录一起删掉 */
  remove(sessionId: string): Promise<void>
  /** 去取已归档的会话。取到之后放在侧栏的数据里，之后跟着变 */
  loadArchived(): Promise<void>
  /**
   * 发消息时能选的模型和权限预设。一次连接只问一遍；
   * 完整模式下每个 harness 各问一遍、各记各的，harness 说要哪一份，不给就是第一个可用的
   */
  composeOptions(harness?: HarnessId): Promise<ComposeOptions>
  /**
   * 在这个 harness 上不带设置新建会话（在 cwd 下）时对面会用的模型、强度、权限档。不记着，每次现问：
   * 别处改了配置、dsh 在别的会话里选了模型，都会让它变
   */
  newSessionDefaults(harness: HarnessId | undefined, cwd: string | null): Promise<SessionDefaults>
  /** 这个 harness 在 cwd 这个工作目录下能用的技能。它带不了技能、对面不认识这个方法时抛 unsupported */
  skills(harness: HarnessId | undefined, cwd: string | null): Promise<SkillCatalog>
  send(sessionId: string, message: OutgoingMessage): Promise<void>
  steer(sessionId: string, messageId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  unqueue(sessionId: string, messageId: string): void
  respond(sessionId: string, requestId: string, choice: RequestChoice): void
  fork(sessionId: string, turnId: string): Promise<string>
  rollback(sessionId: string, turnId: string): Promise<void>
  compact(sessionId: string): Promise<void>
  markRead(sessionId: string): void
  /**
   * 订阅这台设备的管理数据（设置的结构和现在的值）。先给快照，之后给增量；返回退订函数。
   * 对面没有设置接口时抛 unsupported；设备还没连上时订阅照样成立，连上之后才有快照
   */
  openManage(sink: HostSink): () => void
  /** 改设置。全有或全无；别处先改过了以 conflict 结束，什么都没写 */
  writeSettings(
    expectedVersion: number,
    edits: readonly SettingEditView[],
  ): Promise<SettingsWriteResult>
  /** 重启一个 harness。它有回合在跑、又没说照做（force）时以 busy 结束 */
  restartHarness(harness: HarnessId, force: boolean): Promise<HarnessRestartResult>
  runDiagnostics(harness?: HarnessId): Promise<DiagnosticsView>
  readLogs(source: LogSource, harness?: HarnessId, maxBytes?: number): Promise<LogTailView>
  readSshConfig(): Promise<SshConfigView>
  /** 这台设备上的终端会话：订阅、开、写、关都经它（terminals.mts） */
  readonly terminals: Terminals
  /** 这台设备上的文件：列目录、读文件、找文件（files.mts） */
  readonly files: Files
  /** 这台设备上的差异：没提交的改动、暂存和还原（diffs.mts） */
  readonly diffs: Diffs
}

const PAGE = 100
/** 翻页的上限。对面的游标出问题时不至于一直翻下去 */
const MAX_PAGES = 500
/**
 * 设备服务声明了报自己的来历、这次却没给时，隔多久再问、最多再问几次。
 * 第 n 次等 n 个这么久：加起来十来秒，够设备进程从主进程那里拿到第一条状态
 */
const SERVICE_ASK_MS = 1000
const SERVICE_ASKS = 4

/**
 * 会话目录这一层处理的通知：会话和工作区的增减改，加上完整模式下 harness 的状态变化。
 * 回合、条目、上下文占用、历史被改写那些只有订阅了会话才收得到的，归 live.mts
 */
type DirectoryMethod = Exclude<
  Extract<
    ServerNotificationMethod,
    | `thread/${string}`
    | `project/${string}`
    | `litch/harness/${string}`
    | `litch/thread/${string}`
    | `litch/threadSection/${string}`
  >,
  'thread/tokenUsage/updated' | 'thread/reverted' | 'thread/settings/updated'
>
type Routes = { [M in DirectoryMethod]: (params: ServerNotifications[M]) => void }

export function createDevice(config: DeviceConfig, options: DeviceOptions): Device {
  const { hooks } = options
  const log = (line: string) => options.log?.(`[${config.id}] ${line}`)
  let name = config.name
  let wire = config.wire
  /** 对面是哪一种。认出来之前、对面不是设备服务时都是 single */
  let mode: DeviceView['mode'] = 'single'
  /** 这台设备上的 harness。单 harness 模式下只有对面那一个；完整模式下是设备服务声明的，带着各自的状态 */
  let harnesses: HarnessView[] = []
  /** 对面有没有设备配置接口（deviceSettings 扩展）。认出来之前、对面不是设备服务时都是没有 */
  let manageable = false
  /** 对面有没有可重连的终端（deviceProcesses 扩展）。认出来之前、对面不是设备服务时都是没有 */
  let reattachable = false
  /**
   * 对面在跑的那份设备服务的来历（deviceService 扩展）。对面不是设备服务、它没报，都是 null。
   * 断开之后留着断开前知道的，和 manageable 一样
   */
  let service: DeviceServiceView | null = null
  /** 本机设备：最近一次连上时换版本的结果，外壳给的。没有这回事是 null */
  let upgrade: ServiceUpgradeView | null = null
  /** 等着补问“服务的来历”的那个定时器：取消函数。没在等是 null */
  let askingService: (() => void) | null = null
  /** 设备的主目录和系统。主目录只有设备服务会报 */
  let home: string | null = null
  let platform: string | null = null
  let connection: ConnectionState = 'offline'
  let note: Text | null = null
  /** 现在用不了、而侧栏里还留着它上次的会话的 harness。连着并且对过账之后才有 */
  let stranded: HarnessId[] = []
  let failure: ConnectFailureView | null = null
  let everConnected = false
  let workspaces: WorkspaceView[] = []
  /** 工作区在协议里的原样（项目）。改名字、换颜色时要拿它带着别的键一起发；上次留下的快照里没有 */
  let rawProjects: Project[] = []
  /**
   * 各个 harness 的声明里核心自己要用的部分（认识哪些扩展、有哪几档权限预设）。没有声明的不在里面。
   * 只在连着的时候有：断线重连、它掉线又回来之后重新记
   */
  const terms = new Map<HarnessId, HarnessTerms>()
  /** 能不能整理侧栏。连着、对过账、对面有“项目”这组方法才是 true */
  let organizable = false
  /** 会话目录：只留元数据，不带回合 */
  const threads = new Map<string, Thread>()
  /** 目录是上次留下的那份，还没和对面对过 */
  let stale = false
  /**
   * 没人看着的时候跑完了回合的会话。这是这台电脑自己记的，对面没有这回事：跟着侧栏的快照存，重启之后还在。
   * 只留目录里有的会话（removeThread、setThreads 时清）
   */
  const unread = new Set<string>()
  // 上次留下的侧栏先摆上。会话当时在跑也好、在等也好，现在都不知道了，一律当成没载入
  const remembered = options.snapshot?.load() ?? null
  if (remembered) {
    mode = remembered.mode
    harnesses = remembered.harnesses
    workspaces = remembered.workspaces
    for (const thread of remembered.threads) {
      threads.set(thread.id, { ...thread, turns: [], status: { type: 'notLoaded' } })
    }
    for (const id of remembered.unread) if (threads.has(id)) unread.add(id)
    stale = true
  }
  /** 对面有没有“项目”这组方法：null 是还不知道 */
  let hasProjects: boolean | null = null
  // 每次连上换一个代号；对账途中连接断了，回来的结果按代号作废
  let session = 0
  let online = false
  /** 取目录期间到达的目录通知先攒着，取完再处理，免得被旧的列表结果盖掉 */
  let held: { method: string; params: unknown }[] | null = null
  /** 正在取目录的有几处（全量对账，或者某个 harness 恢复之后的补取）。都取完了才放攒着的通知 */
  let holders = 0
  const unknownNotes = new Set<string>()
  /** 完整模式：最近一次取目录时没有包含进来的 harness，和各自的原因。取到了就从这里拿掉 */
  const gaps = new Map<HarnessId, ThreadListSkippedHarness>()
  /** 最近一次全量对账整个没成的原因。成了就清掉 */
  let catalogError: Text | null = null

  const view = (): DeviceView => ({
    id: config.id,
    name,
    host: config.host,
    kind: config.kind,
    target: config.target,
    wire,
    connection,
    mode,
    os: platform,
    harnesses,
    stranded,
    note,
    failure,
    stale,
    organizable,
    manageable,
    service,
    upgrade,
    tools: toolSwitchesView(),
    // 08 号：远程设备“操作这台电脑”。占位，乙线接上设置后换成真的
    machine: null,
  })

  /** 设置页上的两个开关：这台桌面执行不了的那一项是 null，不出开关 */
  const toolSwitchesView = (): ToolSwitches => {
    const can = options.tools?.namespaces() ?? []
    const now = options.toolSwitches?.() ?? DEFAULT_TOOL_SWITCHES
    return {
      browser: can.includes(CLIENT_TOOL_NAMESPACE.browser) ? now.browser : null,
      computer: can.includes(CLIENT_TOOL_NAMESPACE.computer) ? now.computer : null,
    }
  }

  /**
   * 这个会话属于哪个 harness：完整模式下看聚合面打在会话对象上的，
   * 单 harness 模式下就是对面那一个
   */
  const harnessOf = (thread: Thread): HarnessId =>
    mode === 'full' ? (stampedHarness(thread) ?? 'unknown') : (harnesses[0]?.id ?? 'unknown')
  const harnessName = (id: HarnessId): string =>
    harnesses.find((entry) => entry.id === id)?.name ?? id
  /** 这个 harness 现在能不能用。单 harness 模式下设备连着就算能用；设备服务没声明过的先当能用，让它自己说 */
  const harnessReady = (id: HarnessId): boolean => {
    const entry = mode === 'full' ? harnesses.find((item) => item.id === id) : undefined
    return !entry || entry.state === 'ready'
  }
  /** 请求没做成：换成给人看的错误，聚合面回的那几种说得出是哪一句 */
  const fail = (error: unknown): ChannelError => channelFailure(error, harnessName)

  /**
   * 挂着客户端工具卡片的会话：卡片有几张。对面不知道这边在等人（它那头只是工具还没回），
   * 侧栏上的“等待”记号由这边自己打，和审批一样
   */
  const asking = new Map<string, number>()
  const summaryOf = (thread: Thread): SessionSummary => {
    const summary: SessionSummary = {
      ...projectSummary(thread, {
        harness: harnessOf(thread),
        workspaceId: resolveWorkspace(thread, workspaces, pathTwin(platform)),
      }),
      unread: unread.has(thread.id),
    }
    if (!asking.has(thread.id)) return summary
    return { ...summary, status: 'waiting', waitingFor: 'approval' }
  }
  /** 一个会话上的卡片多了一张（+1）或少了一张（-1）：侧栏那一行跟着换 */
  const markAsking = (threadId: string, change: 1 | -1) => {
    const count = (asking.get(threadId) ?? 0) + change
    if (count > 0) asking.set(threadId, count)
    else asking.delete(threadId)
    const thread = threads.get(threadId)
    if (thread) hooks.sidebarOps([{ op: 'session.upsert', session: summaryOf(thread) }])
  }

  /** 已归档的会话。null：界面还没要过，不去取 */
  let archived: Map<string, Thread> | null = null
  const archivedList = (): SessionSummary[] | null =>
    archived && [...archived.values()].map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt)
  const emitArchived = () => hooks.sidebarOps([{ op: 'archived.set', sessions: archivedList() }])

  const sidebar = (): SidebarView => ({
    deviceId: config.id,
    workspaces,
    sessions: [...threads.values()].map(summaryOf),
    archived: archivedList(),
  })

  const setConnection = (
    next: ConnectionState,
    nextNote: Text | null,
    nextFailure: ConnectFailureView | null = null,
  ) => {
    const sameFailure =
      nextFailure === failure ||
      (nextFailure !== null &&
        failure !== null &&
        nextFailure.stage === failure.stage &&
        nextFailure.retrying === failure.retrying &&
        nextFailure.detail === failure.detail &&
        nextFailure.guide === failure.guide &&
        sameText(nextFailure.text, failure.text))
    if (next === connection && sameText(nextNote, note) && sameFailure) return
    connection = next
    note = nextNote
    failure = nextFailure
    // 连接的状态变了，之前算的不算数：没连着的时候没有，刚连上的要等对过账再算
    stranded = []
    organizable = false
    hooks.device(view())
  }

  /**
   * 连着的时候设备那一行下面要不要说一句：目录整个没取到；有的 harness 问了没取到。
   * 都没有就是 null。“有的 harness 现在用不了”不在这里说：那是常有的事，不值得一直占着一块地方，
   * 由 stranded 给出是哪几个，界面在设备行上只出一个标记
   */
  const catalogNote = (): Text | null => {
    if (catalogError) return catalogError
    if (mode !== 'full') return null
    const failed = [...gaps.values()].filter((gap) => gap.reason === 'failed')
    const first = failed[0]
    if (!first) return null
    const names = listNames(
      failed.map((gap) => gap.harness),
      harnessName,
    )
    return phrase('device.catalogPartial', { names, message: first.message })
  }

  /** 现在用不了、而侧栏里还留着它上次的会话的 harness */
  const strandedNow = (): HarnessId[] => {
    if (!online || mode !== 'full') return []
    const owners = new Set([...threads.values()].map(harnessOf))
    return harnesses
      .filter((entry) => entry.state !== 'ready' && owners.has(entry.id))
      .map((entry) => entry.id)
  }

  /** 设备的显示数据变了（harness 的状态、目录的说明）。changed 为真是别的地方已经变了，一定要报 */
  const syncDevice = (changed = false) => {
    const next = online ? catalogNote() : note
    const left = strandedNow()
    const sameLeft = left.length === stranded.length && left.every((id, at) => id === stranded[at])
    const able = online && hasProjects === true
    if (!changed && sameText(next, note) && sameLeft && able === organizable) return
    note = next
    stranded = left
    organizable = able
    hooks.device(view())
  }

  /** 把现在的侧栏存一份。改得再勤也只隔一会儿存一次 */
  let saving: (() => void) | null = null
  const saveSoon = () => {
    if (!options.snapshot || stale || saving) return
    saving = options.clock.setTimer(() => {
      saving = null
      if (stale) return
      try {
        options.snapshot?.save({
          mode,
          harnesses,
          workspaces,
          threads: [...threads.values()],
          unread: [...unread],
        })
      } catch (error) {
        log(`存侧栏的快照失败：${String(error)}`)
      }
    }, 2000)
  }

  /**
   * 见过的临时会话（ephemeral：起标题之类用一下就扔的，对面不落盘，线程列表里也没有）。不进侧栏；
   * 记下标识，之后它的状态变化、改名这些通知不再去对面要它的信息。卸载了（thread/closed）就忘掉
   */
  const transient = new Set<string>()
  /**
   * 别处建了、还没说过话的会话：没有标题（第一句话是空的，也没起名字），官方桌面端在新对话页上先建好、
   * 还没发消息的那种。上游的线程列表不列第一句话是空的会话，官方桌面端自己先建的也藏着、发出第一句才露出来；
   * 侧栏照这个来：从会话开始的通知、按标识要来的会话对象里见到它时不放进目录，只记下标识，之后的状态变化
   * 不去对面要；它开始第一个回合（状态变成在跑）时再去要，第一句话这时一般已经记下了（见 fetchPreview），
   * 起了名字也去要。卸载、删除、归档了就忘掉；对面的线程列表里有它（有的入口列这种会话）就以列表为准
   */
  const unspoken = new Set<string>()
  /** 侧栏上会写成“没有标题的会话”的：没起名字，也没有第一句话 */
  const titleless = (thread: Thread): boolean => typeof threadTitle(thread) !== 'string'

  const upsertThread = (thread: Thread) => {
    if (thread.ephemeral) {
      transient.add(thread.id)
      return
    }
    unspoken.delete(thread.id)
    // 目录里不留回合，会话内容打开时再取
    const kept: Thread = { ...thread, turns: [] }
    threads.set(kept.id, kept)
    hooks.sidebarOps([{ op: 'session.upsert', session: summaryOf(kept) }])
    saveSoon()
  }

  /**
   * 不是从线程列表、也不是自己建的会话对象（会话开始的通知、按标识要来的）：放进目录。
   * 目录里还没有、又还没说过话的不放，见 unspoken
   */
  const adopt = (thread: Thread) => {
    if (!thread.ephemeral && titleless(thread) && !threads.has(thread.id)) {
      unspoken.add(thread.id)
      return
    }
    upsertThread(thread)
  }

  const removeThread = (threadId: string) => {
    unread.delete(threadId)
    unspoken.delete(threadId)
    live.forget(threadId)
    if (threads.delete(threadId)) hooks.sidebarOps([{ op: 'session.remove', sessionId: threadId }])
    saveSoon()
  }

  /** 归档了：从列表里拿掉。已归档的那张表界面要过的话，放进去 */
  const shelve = (threadId: string) => {
    const thread = threads.get(threadId)
    removeThread(threadId)
    if (!archived || archived.has(threadId)) return
    if (thread) {
      archived.set(threadId, thread)
      emitArchived()
    } else {
      // 不在我们列表里的会话被归档了（别处建的、还没同步过来的）：重新取一遍
      void loadArchived().catch((error: unknown) => log(`取已归档的会话失败：${String(error)}`))
    }
  }

  const unshelve = (threadId: string) => {
    if (archived?.delete(threadId)) emitArchived()
  }

  /**
   * 目录里没有的会话：向对面要它的元数据。spoken：已经知道它开始了回合，第一句话读不到也放进侧栏
   */
  const fetchThread = async (threadId: string, spoken = false) => {
    const mine = session
    try {
      const { thread } = await link.request('thread/read', { threadId, includeTurns: false })
      if (mine !== session) return
      if (spoken) upsertThread(thread)
      else adopt(thread)
    } catch (error) {
      log(`取会话 ${threadId} 的信息失败：${String(error)}`)
    }
  }

  /**
   * 侧栏上没有标题的会话开始或结束了一个回合：去要它的第一句话。对面不为“有了第一句话”发通知；
   * 上游记下第一句用户消息时就落盘，回合开始以后就读得到，适配器的 Claude Code 入口在宣布回合开始之前就填上了，
   * Pi 入口要到回合结束才有（实测 2026-10-15），所以回合结束时还没有的再去要一次。只拿这一项，别的以通知为准
   */
  const fetchPreview = async (threadId: string) => {
    const mine = session
    try {
      const { thread } = await link.request('thread/read', { threadId, includeTurns: false })
      const known = threads.get(threadId)
      if (mine === session && thread.preview && known && titleless(known)) {
        upsertThread({ ...known, preview: thread.preview })
      }
    } catch (error) {
      log(`取会话 ${threadId} 的第一句话失败：${String(error)}`)
    }
  }

  const patchThread = (threadId: string, patch: Partial<Thread>) => {
    if (transient.has(threadId)) return
    const thread = threads.get(threadId)
    const shelved = archived?.get(threadId)
    if (thread) upsertThread({ ...thread, ...patch })
    else if (shelved) {
      // 归档了的会话变了（改名之类）：改在那张表里，不把它放回列表
      archived?.set(threadId, { ...shelved, ...patch })
      emitArchived()
    } else if (!unspoken.has(threadId) || patch.name) void fetchThread(threadId)
  }

  const loadProjects = async (): Promise<Project[]> => {
    if (hasProjects === false) return []
    const all: Project[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: ProjectListResponse = await link.request(
          'project/list',
          cursor ? { cursor } : {},
        )
        all.push(...result.data)
        if (!result.nextCursor || result.nextCursor === cursor) break
        cursor = result.nextCursor
      }
      hasProjects = true
    } catch (error) {
      // 对面没有这组方法：记住，之后不再试
      if (!(error instanceof RpcError) || !isUnknownMethodError(error.code)) throw error
      hasProjects = false
    }
    return all
  }

  /**
   * 翻页取完一份会话列表。shelved：取已归档的那些。
   * only 只在完整模式下给：只取这一个 harness 的（它恢复可用之后补它那一份用）；聚合面之外没有这个参数
   */
  const loadThreads = (shelved = false, only: HarnessId | null = null): Promise<Listing> =>
    collectThreads((cursor) =>
      link.request('thread/list', {
        limit: PAGE,
        // 不按模型供应商筛。原生 codex 在不带这一项时只列“当前供应商”的会话，
        // 用户换过供应商之后以前的会话就不见了；给空数组是明说“都要”。别的引擎不看它
        modelProviders: [],
        ...(shelved ? { archived: true } : {}),
        ...(cursor ? { cursor } : {}),
        ...(only === null ? {} : { harness: only }),
      }),
    )

  /** 设备服务现在声明为不可用的 harness：取到的列表里没有它们，它们原来的会话要留着 */
  const downHarnesses = (): HarnessId[] =>
    mode === 'full'
      ? harnesses.filter((entry) => entry.state !== 'ready').map((entry) => entry.id)
      : []

  /** 新取到的已归档列表并进那张表。没包含进来的 harness，它原来在表里的留着 */
  const setArchived = (listing: Listing, only: HarnessId | null = null) => {
    archived = mergeListing(archived?.values() ?? [], listing, harnessOf, only, downHarnesses())
  }

  async function loadArchived(): Promise<void> {
    const mine = session
    const listing = await loadThreads(true)
    if (mine !== session) return
    setArchived(listing)
    emitArchived()
  }

  /** 新取到的列表并进会话目录，记下这一次哪些 harness 没有包含进来 */
  const setThreads = (listing: Listing, only: HarnessId | null = null) => {
    const next = mergeListing(threads.values(), listing, harnessOf, only, downHarnesses())
    threads.clear()
    for (const [id, thread] of next) threads.set(id, thread)
    // 设备上已经没有了的会话，未读也不留
    for (const id of unread) if (!threads.has(id)) unread.delete(id)
    // 列表里有了的就不再是“还没说过话”的
    for (const id of unspoken) if (threads.has(id)) unspoken.delete(id)
    if (only === null) gaps.clear()
    else gaps.delete(only)
    for (const gap of listing.skipped) gaps.set(gap.harness, gap)
  }

  /** 开始取目录：从现在起目录的通知先攒着 */
  const hold = () => {
    held ??= []
    holders++
  }

  /** 这一处取完了。都取完了就把攒着的通知按顺序放出来。连接已经换过一次的不算数 */
  const unhold = (mine: number) => {
    if (mine !== session) return
    holders = Math.max(0, holders - 1)
    if (holders > 0) return
    const pending = held ?? []
    held = null
    for (const entry of pending) route(entry.method, entry.params)
  }

  /**
   * 一个 harness 恢复可用了（设计文档 03 第 5.5 节）：它上面打开着的会话重新订阅——之前的订阅随它的
   * 上游连接一起丢了；它的会话列表补取一遍——不可用的那段时间里，合并的列表里没有它。
   */
  const recover = async (id: HarnessId) => {
    const mine = session
    composeCache.delete(id)
    live.harnessUp(id)
    hold()
    try {
      const listing = await loadThreads(false, id)
      const shelved = archived ? await loadThreads(true, id) : null
      if (mine !== session) return
      setThreads(listing, id)
      if (shelved) setArchived(shelved, id)
      hooks.sidebar(sidebar())
      saveSoon()
    } catch (error) {
      if (mine !== session) return
      const message = error instanceof Error ? error.message : String(error)
      log(`补取 ${id} 的会话失败：${message}`)
      gaps.set(id, { harness: id, reason: 'failed', message })
    } finally {
      unhold(mine)
      if (mine === session) syncDevice()
    }
  }

  /** 记下（或者忘掉）一个 harness 的声明 */
  const remember = (id: HarnessId, declared: HarnessTerms | null) => {
    if (declared) terms.set(id, declared)
    else terms.delete(id)
  }

  /** 设备服务说某个 harness 的状态变了。只有聚合面会发 */
  const harnessChanged = ({
    harness: id,
    info,
  }: ServerNotifications['litch/harness/status/changed']) => {
    if (mode !== 'full') return
    const next = harnessFromInfo(info)
    remember(id, termsOf(info))
    const at = harnesses.findIndex((entry) => entry.id === id)
    const wasReady = harnesses[at]?.state === 'ready'
    harnesses = at < 0 ? [...harnesses, next] : harnesses.with(at, next)
    if (next.state === 'ready') {
      // 取目录时它被跳过了的话，就算我们这边一直当它可用，也要补取
      if (!wasReady || gaps.has(id)) void recover(id)
    } else if (wasReady) {
      composeCache.delete(id)
      live.harnessDown(id)
    }
    syncDevice(true)
    saveSoon()
  }

  const routes: Routes = {
    'thread/started': ({ thread }) => adopt(thread),
    'thread/status/changed': ({ threadId, status }) => {
      const known = threads.get(threadId)
      if (!known) {
        if (status.type === 'active' && !transient.has(threadId) && !archived?.has(threadId)) {
          // 目录里没有的会话开始了一个回合（多半是别处建的、刚说了第一句）：去要来放进侧栏。第一句话这时
          // 一般已经记下了；一时读不到也放进来，它在跑就是一段真的对话，回合结束时会再去要
          unspoken.delete(threadId)
          void fetchThread(threadId, true)
        } else if (!unspoken.has(threadId)) {
          patchThread(threadId, { status })
        }
        // 还没说过话的会话载入、卸载了：不用管
        return
      }
      const was = known.status?.type === 'active'
      const running = status.type === 'active'
      // 从“在跑”变成“停了”，而界面上没人开着它：标成未读
      if (was && !running && !live.watched(threadId)) unread.add(threadId)
      if (was === running) {
        patchThread(threadId, { status })
        return
      }
      // 回合开始了或者结束了。上游的 updatedAt 是会话记录最后写入的时间，回合里一直在写，
      // 可发给所有连接的通知里都不带它：没打开的会话只有状态变化可看，侧栏上的时间这边照着记
      patchThread(threadId, { status, updatedAt: Math.floor(options.clock.now() / 1000) })
      if (titleless(known)) void fetchPreview(threadId)
    },
    'thread/name/updated': ({ threadId, threadName }) =>
      patchThread(threadId, { name: threadName ?? null }),
    'thread/archived': ({ threadId }) => shelve(threadId),
    'thread/deleted': ({ threadId }) => {
      removeThread(threadId)
      live.forget(threadId, true)
      unshelve(threadId)
    },
    // 对面把没人订阅、闲着的会话卸载了。卸载之前它已经发过 thread/status/changed（变成 notLoaded），
    // 侧栏要的都在那条里；官方桌面端也只拿它收拾跟这个会话绑着的东西。这里只忘掉
    // 临时会话和还没说过话的会话的标识（还没说过话就卸载了的，记录不落盘，以后也不会有它的事）
    'thread/closed': ({ threadId }) => {
      transient.delete(threadId)
      unspoken.delete(threadId)
    },
    'thread/unarchived': ({ threadId }) => {
      unshelve(threadId)
      live.restored(threadId)
      void fetchThread(threadId)
    },
    // 工作区和归属：单 harness 模式下是那个引擎自己的；完整模式下是设备层的、跨 harness
    // （引擎各自的那一份聚合面不往上转）。别的连接改了也是从这里知道的
    'thread/project/updated': ({ threadId, projectId }) => patchThread(threadId, { projectId }),
    // 对面没有这组方法的（旧版的设备服务把引擎自己的项目通知原样转上来）不用管
    'project/changed': () => {
      if (hasProjects !== false) void refreshProjects()
    },
    // 置顶、取消置顶，进了、出了、换了分区（别的连接做的也是从这里知道的）
    'litch/thread/section/updated': ({ threadId, section, sectionEnteredAt }) =>
      patchThread(threadId, { section, sectionEnteredAt }),
    // 分区本身建了、改了、删了。这一版不管理分区：分区的名字跟着会话对象走，
    // 里面的会话各自会有上面那条通知，这里没有要做的
    'litch/threadSection/changed': () => {},
    'litch/harness/status/changed': harnessChanged,
  }

  const route = (method: string, params: unknown) => {
    const handler = (routes as Record<string, ((params: never) => void) | undefined>)[method]
    if (handler) {
      handler(params as never)
    } else if (live.notification(method, params)) {
      // 会话里的事，已经交给打开着的那个会话了
    } else if (!unknownNotes.has(method)) {
      // 不认识的通知只记一次就丢掉，绝不因此刷新整张表
      unknownNotes.add(method)
      log(`不处理的通知：${method}`)
    }
  }

  const reconcile = async () => {
    const mine = session
    hold()
    try {
      const projects = await loadProjects()
      // 完整模式下这是各个 harness 合并后的列表；当时不可用的 harness 不在里面，它上次的会话留着
      const listing = await loadThreads()
      // 界面要过已归档的那张表：对账时一起重新取
      const shelved = archived ? await loadThreads(true) : null
      if (mine !== session) return
      workspaces = projectWorkspaces(projects)
      rawProjects = projects
      setThreads(listing)
      if (shelved) setArchived(shelved)
      catalogError = null
      hooks.sidebar(sidebar())
      terminals.regroup()
      // 和对面对过了，不再是上次留下的那份
      const fresh = stale
      stale = false
      syncDevice(fresh)
      saveSoon()
    } catch (error) {
      if (mine !== session) return
      log(`取会话目录失败：${String(error)}`)
      catalogError = phrase('device.catalogFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
      syncDevice()
    } finally {
      unhold(mine)
    }
  }

  const reloadProjects = async () => {
    const mine = session
    try {
      const projects = await loadProjects()
      if (mine !== session) return
      workspaces = projectWorkspaces(projects)
      rawProjects = projects
      hooks.sidebar(sidebar())
      terminals.regroup()
      saveSoon()
    } catch (error) {
      log(`取工作区失败：${String(error)}`)
    }
  }

  /** 正在重新取工作区的那一趟。null：没有在取 */
  let refreshing: Promise<void> | null = null
  /** 取的途中又有人要取：这一次取完再取一遍，免得拿到的是改动之前的 */
  let refreshAgain = false

  /**
   * 重新取一遍工作区，侧栏整份换掉（会话归到哪个工作区是按整张表算的）。
   * 同时来的几次合成一趟：自己改完要取、对面的通知到了也要取，常常是前后脚
   */
  const refreshProjects = (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    const run = async () => {
      do {
        refreshAgain = false
        await reloadProjects()
      } while (refreshAgain)
    }
    refreshing = run().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  /**
   * 设备服务声明了报自己的来历，这一次的应答里却没有：设备进程刚起来、主进程的第一条状态还没送到它那里
   * （协议扩展 deviceService 里写明了有这一小会儿，没有就是“还不知道”）。来历没有变化通知，只能隔一会儿再问：
   * 问到了补上；问了几次都没有就算了，下次连上再说。连接断了、换了一条，这一趟就作废
   */
  const askServiceLater = (mine: number, attempt: number) => {
    askingService = options.clock.setTimer(() => {
      askingService = null
      if (mine !== session) return
      link.request('runtime/info', {}).then(
        (info) => {
          if (mine !== session) return
          const found = isDeviceRuntime(info) ? projectService(info.device.service) : null
          if (found) {
            service = found
            hooks.device(view())
          } else if (attempt < SERVICE_ASKS) askServiceLater(mine, attempt + 1)
        },
        (error: unknown) => {
          if (mine === session) log(`补问设备服务的来历失败：${String(error)}`)
        },
      )
    }, SERVICE_ASK_MS * attempt)
  }

  /** 握手之后：认出对面是谁，再做全量对账 */
  const identify = async () => {
    const mine = session
    // 上一次连接时认的声明不算数了：对面可能升级过
    terms.clear()
    /** 对面说了会报服务的来历，这一次却没给：过一会儿要再问 */
    let serviceDue = false
    try {
      const info = await link.request('runtime/info', {})
      if (mine !== session) return
      if (isDeviceRuntime(info)) {
        // 设备服务：一条连接里有多个 harness，各自的名字、版本、状态由它声明
        // 设备级的工作区：它声明了这项扩展的，每次连上都重新去取（上次说没有的，可能是升级之前的事）；
        // 没有声明的退回“问一次、记住”。上一次连的不是设备服务的话，那时认的也不算数
        const declares = info.device.extensions?.includes(EXTENSION.deviceWorkspaces) === true
        if (declares || mode !== 'full') hasProjects = null
        mode = 'full'
        harnesses = info.harnesses.map(harnessFromInfo)
        for (const entry of info.harnesses) remember(entry.id, termsOf(entry))
        // 设置接口有没有，看它声明的扩展，不看版本号
        manageable = info.device.extensions?.includes(EXTENSION.deviceSettings) === true
        reattachable = info.device.extensions?.includes(EXTENSION.deviceProcesses) === true
        // 在跑的是哪一份服务：握手时声明过才给，旧版的设备服务不报
        service = projectService(info.device.service)
        serviceDue =
          service === null && info.device.extensions?.includes(EXTENSION.deviceService) === true
        home = typeof info.device.home === 'string' ? info.device.home : null
        platform = info.device.os ?? null
      } else {
        // 上一次连的是设备服务的话，那时认的不算数：单个入口有没有这组方法要问了才知道
        if (mode === 'full') hasProjects = null
        remember(harnessFromRuntimeInfo(info).id, termsOf(info))
        mode = 'single'
        harnesses = [harnessFromRuntimeInfo(info)]
        manageable = false
        reattachable = false
        service = null
        home = null
      }
    } catch (error) {
      if (mine !== session) return
      if (!(error instanceof RpcError) || !isUnknownMethodError(error.code)) {
        log(`问对面是谁失败：${String(error)}`)
      }
      const state = link.state
      if (state.phase !== 'connected') return
      if (mode === 'full') hasProjects = null
      mode = 'single'
      harnesses = [codexHarness(state.info)]
      manageable = false
      reattachable = false
      service = null
      home = null
    }
    // 握手应答里有对面的系统；设备服务另外报过的以它为准
    const linked = link.state
    if (mode !== 'full' && linked.phase === 'connected') platform = linked.info.platformOs ?? null
    // 本机：这一次打开传输时换没换版本。外壳在传输打开之前就记好了，这里取到的就是这条连接的
    upgrade = projectUpgrade(config.upgrade?.())
    online = true
    everConnected = true
    // 上一次连接留下的说明不算数了，对账之后重新算
    gaps.clear()
    catalogError = null
    setConnection('online', null)
    if (serviceDue) askServiceLater(mine, 1)
    live.resync()
    manage.resync()
    terminals.resync()
    files.resync()
    diffs.resync()
    await reconcile()
  }

  const onState = (state: LinkState) => {
    if (state.phase !== 'connected') {
      session++
      const dropped = online
      online = false
      held = null
      holders = 0
      askingService?.()
      askingService = null
      if (dropped) toolCalls.offline()
      if (dropped) live.offline()
      if (dropped) terminals.offline()
      if (dropped) files.offline()
      if (dropped) diffs.offline()
      manage.offline()
    }
    switch (state.phase) {
      case 'idle':
        setConnection('offline', null)
        return
      case 'connecting':
      case 'handshaking': {
        const next = everConnected || state.attempt > 1 ? 'reconnecting' : 'connecting'
        // 报了走到哪一步就显示那一步；没报的话，重试途中先留着上一次没连上的原因，免得一闪一闪
        const step = state.phase === 'connecting' ? state.step : null
        if (step) setConnection(next, step, state.attempt > 1 ? failure : null)
        else
          setConnection(next, state.attempt > 1 ? note : null, state.attempt > 1 ? failure : null)
        return
      }
      case 'waiting':
        setConnection('reconnecting', state.failure.text, { ...state.failure, retrying: true })
        return
      case 'failed':
        setConnection('error', state.failure.text, { ...state.failure, retrying: false })
        return
      case 'connected':
        session++
        // 从这一刻到对账结束，通知都先攒着
        held = []
        holders = 0
        void identify()
    }
  }

  const link = createLink({
    open: config.open,
    clock: options.clock,
    clientInfo: options.clientInfo,
    clientTools: () => options.tools?.namespaces() ?? [],
    state: onState,
    notification(method, params) {
      // 引擎撤回了一个请求（别处答了、作废了）：正在执行的客户端工具调用不等了。会话里的卡片照常由下面撤
      if (method === 'serverRequest/resolved') {
        const requestId = (params as { requestId?: unknown } | null)?.requestId
        if (requestId !== undefined && requestId !== null) toolCalls.resolved(String(requestId))
      }
      // 设置变了：和会话目录是两回事，不跟着对账攒着（攒着再放会把读到的新值盖回去）
      if (method === DEVICE_SETTINGS_CHANGED) {
        manage.changed(params as DeviceSettingsChangedNotification)
        return
      }
      // 差异面板在设备上跑的命令结束了、它盯着的路径变了：先认它自己起的那些，剩下的进程通知才是终端的
      if (diffs.notification(method, params)) return
      // 终端的输出和进程的增减：量大、和会话目录无关，不经下面那几道
      if (terminals.notification(method, params)) return
      // 目录的通知在对账期间先攒着；会话里的通知不碰目录，不用等
      if (held && method in routes) held.push({ method, params })
      else route(method, params)
    },
    request: (method, params, id) =>
      toolCalls.serverRequest(method, params, id) ?? live.serverRequest(method, params, id),
    log,
  })

  const live = createLiveSessions({
    deviceId: config.id,
    clock: options.clock,
    online: () => online,
    harnessFor: harnessOf,
    owner(sessionId) {
      const thread = threads.get(sessionId) ?? archived?.get(sessionId)
      return thread ? harnessOf(thread) : null
    },
    ready: harnessReady,
    sole: () => (mode === 'full' ? null : (harnesses[0]?.id ?? null)),
    harnessName,
    declared: (id): HarnessAbilities | null =>
      harnesses.find((entry) => entry.id === id)?.abilities ?? null,
    terms: (id) => terms.get(id) ?? null,
    shelved: (sessionId) => archived?.has(sessionId) ?? false,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    touched(sessionId, said) {
      const thread = threads.get(sessionId)
      if (!thread) return
      upsertThread({
        ...thread,
        // 对面是拿第一句话当会话的预览的，但不会为此发通知：这边先照着填上
        preview: thread.preview || said || '',
        updatedAt: Math.floor(options.clock.now() / 1000),
      })
    },
    started: (thread) => upsertThread(thread),
    turnEnded(sessionId, turnId) {
      diffs.turnEnded(sessionId)
      toolCalls.turnEnded(sessionId, turnId)
    },
    interrupting: (sessionId) => toolCalls.interrupted(sessionId),
    dynamicTools(harness) {
      // 按声明给：引擎在 runtime/info 的 extensions 里报了 clientTools 才带（dsh 不认这个参数，决 197；
      // 还没接上客户端工具的引擎也不报）。没有声明的是更早的适配器，那时只有 dsh 不认
      const declared = harness === null ? undefined : terms.get(harness)
      if (declared ? !declared.extensions.includes(EXTENSION.clientTools) : harness === 'dsh') {
        return null
      }
      return clientToolSpecs(options.tools?.namespaces() ?? [])
    },
    turnDiff: (sessionId, turnId, diff) => diffs.turnDiff(sessionId, turnId, diff),
    log,
  })

  /** 这台桌面执行客户端工具（内置浏览器、Computer Use）的调用：开关、交给主进程、卡片、收尾（tool-calls.mts） */
  const toolCalls = createToolCalls({
    deviceId: config.id,
    clock: options.clock,
    hub: options.tools ?? {
      namespaces: () => [],
      call: () => {},
      cancel: () => {},
      answer: () => {},
      turnEnded: () => {},
    },
    device: (): ToolInvocation['device'] => ({
      id: config.id,
      // 核心不认识语言：本机的名字是一句“本机”，给执行器的是主机标识
      name: typeof name === 'string' ? name : config.host,
      kind: config.kind,
      target: sshTarget(config.target),
    }),
    allowed(namespace) {
      const now = options.toolSwitches?.() ?? DEFAULT_TOOL_SWITCHES
      if (namespace === CLIENT_TOOL_NAMESPACE.browser) return now.browser
      if (namespace === CLIENT_TOOL_NAMESPACE.computer) return now.computer
      return true
    },
    context(threadId) {
      const thread = threads.get(threadId) ?? archived?.get(threadId)
      return {
        harness: thread ? harnessOf(thread) : mode === 'full' ? null : (harnesses[0]?.id ?? null),
        cwd: thread?.cwd || null,
      }
    },
    showAsk(place: ToolAskPlace, answer) {
      const request = {
        id: `litch-ask:${place.askId}`,
        kind: 'clientAsk' as const,
        itemId: null,
        device: { name, kind: config.kind, host: config.host },
        tool: { namespace: place.namespace, name: place.tool },
        ask: place.ask,
        options: clientAskOptions(place.ask),
      }
      markAsking(place.threadId, 1)
      let counted = true
      const uncount = () => {
        if (!counted) return
        counted = false
        markAsking(place.threadId, -1)
      }
      const drop = live.clientAsk(place, request, (picked) => {
        uncount()
        answer(picked)
      })
      return () => {
        uncount()
        drop()
      }
    },
    log,
  })

  const organize = createOrganizer({
    online: () => online,
    capable: () => hasProjects === true,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    projects: () => rawProjects,
    reload: () => refreshProjects(),
    thread: (sessionId) => threads.get(sessionId),
    put: (thread) => upsertThread(thread),
    now: () => options.clock.now(),
  })

  const manage = createManagement({
    deviceId: config.id,
    online: () => online,
    supported: () => manageable,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    log,
  })

  const sameDir = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

  const terminals = createTerminals({
    deviceId: config.id,
    clock: options.clock,
    online: () => online,
    durable: () => mode === 'full' && reattachable,
    platform: () => platform,
    home: () => home,
    hasWorkspace: (id) => workspaces.some((workspace) => workspace.id === id),
    workspaceRoot: (id) => workspaces.find((workspace) => workspace.id === id)?.roots[0] ?? null,
    workspaceByRoot: (root) =>
      workspaces.find((workspace) => {
        const first = workspace.roots[0]
        return first !== undefined && sameDir(first, root)
      })?.id ?? null,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    log,
    ...(options.terminalNotes ? { notes: options.terminalNotes } : {}),
  })

  const files = createFiles({
    clock: options.clock,
    online: () => online,
    platform: () => platform,
    knownRoot: (root) => knownRoot(root),
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    log,
  })

  /** 认得的根：工作区的根，和会话的工作目录（不属于工作区的会话，面板以它的工作目录为根） */
  const knownRoot = (root: string): boolean => {
    if (workspaces.some((workspace) => workspace.roots.some((entry) => sameDir(entry, root)))) {
      return true
    }
    for (const thread of threads.values()) if (sameDir(thread.cwd, root)) return true
    return false
  }

  const diffs = createDiffs({
    clock: options.clock,
    online: () => online,
    platform: () => platform,
    knownRoot,
    turnDiffDeclared(sessionId) {
      const thread = threads.get(sessionId)
      if (!thread) return null
      const owner = harnessOf(thread)
      return harnesses.find((entry) => entry.id === owner)?.abilities?.turnDiff ?? null
    },
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    log,
  })

  /**
   * 模型清单。对面没有这个方法就当没有可选的模型，界面不显示选择器。
   * harness 只在完整模式下给：聚合面上这是“针对某个 harness”的请求，要指明问谁
   */
  const listModels = async (harness: HarnessId | null): Promise<Model[]> => {
    const models: Model[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: ModelListResponse = await link.request('model/list', {
          cursor,
          limit: PAGE,
          ...(harness === null ? {} : { harness }),
        })
        models.push(...result.data)
        cursor = result.nextCursor
        if (!cursor) break
      }
    } catch (error) {
      if (!(error instanceof RpcError) || !isUnknownMethodError(error.code)) throw error
    }
    return models
  }
  /**
   * 问过的模型清单。键是 harness 的标识：完整模式下每个 harness 各问一遍、各记各的；
   * 单 harness 模式下只有一份，键是空串
   */
  const composeCache = new Map<string, { session: number; value: Promise<ComposeOptions> }>()

  /** 完整模式下这件事落在哪个 harness 上：界面给了就用给的，没给就是第一个可用的 */
  const pickHarness = (wanted: HarnessId | undefined): HarnessId => {
    const target = wanted ?? harnesses.find((entry) => entry.state === 'ready')?.id
    if (target) return target
    throw new ChannelError(
      'rejected',
      '这台设备上现在没有可用的 harness',
      phrase('fault.noHarness'),
    )
  }

  const aids = createComposeAids({
    online: () => online,
    target: (wanted) => (mode === 'full' ? pickHarness(wanted) : null),
    sole: () => (mode === 'full' ? null : (harnesses[0]?.id ?? null)),
    declared: (id) => harnesses.find((entry) => entry.id === id)?.abilities ?? null,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
  })

  /** 对面成了才往下走；没成的换成给人看的错误 */
  const guarded = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      throw fail(error)
    }
  }

  return {
    get view() {
      return view()
    },
    get sidebar() {
      return sidebar()
    },
    get online() {
      return online
    },
    start: () => link.start(),
    stop: () => link.stop(),
    // 连着的时候也照做：丢掉这条连接重新连一次，对面换了东西（装上了设备服务）就此换过去
    retry: () => (online ? link.reopen() : link.retry()),
    update(patch) {
      if (patch.name !== undefined) name = patch.name
      if (patch.wire !== undefined) wire = patch.wire
      hooks.device(view())
    },
    refresh: () => (online ? reconcile() : Promise.resolve()),
    openSession: (sessionId, sink) => live.open(sessionId, sink),
    async create(cwd, message, settings, harness, workspaceId) {
      // 聚合面上新建会话必须说建在哪个 harness 上；别的对面没有这个参数，不带
      const target = mode === 'full' ? pickHarness(harness) : null
      // 归到哪个工作区：对面有这组方法、这个工作区也还在才带
      const home =
        workspaceId && hasProjects === true && workspaces.some((entry) => entry.id === workspaceId)
          ? workspaceId
          : null
      return live.create(cwd, message, settings, target, home)
    },
    organize,
    rootCandidates: () =>
      looseDirectories(
        threads.values(),
        (thread) => resolveWorkspace(thread, workspaces, pathTwin(platform)) !== null,
      ),
    configure: (sessionId, settings) => live.configure(sessionId, settings),
    implementPlan: (sessionId, text) => live.implementPlan(sessionId, text),
    // 这三件事对面成了之后会发通知，但不一定发给提出请求的这条连接：这边自己先改，通知再来是幂等的
    async rename(sessionId, title) {
      const name = title.trim()
      if (!name) throw new ChannelError('rejected', '名字不能是空的')
      await guarded(() => link.request('thread/name/set', { threadId: sessionId, name }))
      const thread = threads.get(sessionId)
      if (thread) upsertThread({ ...thread, name })
    },
    async archive(sessionId) {
      await guarded(() => link.request('thread/archive', { threadId: sessionId }))
      shelve(sessionId)
    },
    async unarchive(sessionId) {
      const { thread } = await guarded(() =>
        link.request('thread/unarchive', { threadId: sessionId }),
      )
      unshelve(sessionId)
      upsertThread(thread)
      live.restored(sessionId)
    },
    async remove(sessionId) {
      await guarded(() => link.request('thread/delete', { threadId: sessionId }))
      removeThread(sessionId)
      live.forget(sessionId, true)
      unshelve(sessionId)
    },
    async loadArchived() {
      if (!online) throw new ChannelError('offline', '设备没有连上')
      await guarded(loadArchived)
    },
    async composeOptions(harness) {
      if (!online) throw new ChannelError('offline', '设备没有连上')
      const target = mode === 'full' ? pickHarness(harness) : null
      const key = target ?? ''
      // 换了一次连接就重新问：对面可能升级过，或者刚登录完。某个 harness 掉线再回来也一样（见 recover）
      const cached = composeCache.get(key)
      if (cached?.session === session) return cached.value
      // 权限预设：这个 harness 声明了就用它的，没有声明用内置的三档
      const owner = target ?? harnesses[0]?.id ?? ''
      const presets = terms.get(owner)?.presets ?? null
      const value = Promise.all([
        guarded(() => listModels(target)),
        aids.plan(target ?? undefined),
      ]).then(([models, plan]) => composeOptions(models, presets, plan))
      // 没问成的不留着，下次再问。一个模型都没报的也不留：ACP 这类引擎要建过会话才知道有哪些模型，
      // 记住了空清单，建完会话也一直没有选择器
      const drop = () => {
        if (composeCache.get(key)?.value === value) composeCache.delete(key)
      }
      value.then((options) => {
        if (options.models.length === 0) drop()
      }, drop)
      composeCache.set(key, { session, value })
      return value
    },
    async newSessionDefaults(harness, cwd) {
      if (!online) throw new ChannelError('offline', '设备没有连上')
      const target = mode === 'full' ? pickHarness(harness) : null
      const routed = target === null ? {} : { harness: target }
      // 对面不认识这两个方法（旧一些的对面）当它什么都没说
      const unknown = (error: unknown): null => {
        if (error instanceof RpcError && isUnknownMethodError(error.code)) return null
        throw error
      }
      const [requirements, config] = await guarded(() =>
        Promise.all([
          link
            .request('configRequirements/read', routed)
            .then((result) => result.requirements, unknown),
          link
            .request('config/read', { ...routed, ...(cwd ? { cwd } : {}) })
            .then((result) => result.config, unknown),
        ]),
      )
      return projectDefaults(requirements, config)
    },
    skills: (harness, cwd) => aids.skills(harness, cwd),
    send: (sessionId, message) => live.send(sessionId, message),
    steer: (sessionId, messageId) => live.steer(sessionId, messageId),
    interrupt: (sessionId) => live.interrupt(sessionId),
    unqueue: (sessionId, messageId) => live.unqueue(sessionId, messageId),
    respond: (sessionId, requestId, choice) => live.respond(sessionId, requestId, choice),
    fork: (sessionId, turnId) => live.fork(sessionId, turnId),
    rollback: (sessionId, turnId) => live.rollback(sessionId, turnId),
    compact: (sessionId) => live.compact(sessionId),
    markRead(sessionId) {
      if (!unread.delete(sessionId)) return
      const thread = threads.get(sessionId)
      if (thread) hooks.sidebarOps([{ op: 'session.upsert', session: summaryOf(thread) }])
      saveSoon()
    },
    openManage: (sink) => manage.open(sink),
    writeSettings: (expectedVersion, edits) => manage.write(expectedVersion, edits),
    restartHarness: (harness, force) => manage.restart(harness, force),
    runDiagnostics: (harness) => manage.diagnostics(harness),
    readLogs: (source, harness, maxBytes) => manage.logs(source, harness, maxBytes),
    readSshConfig: () => manage.sshConfig(),
    terminals,
    files,
    diffs,
  }
}
