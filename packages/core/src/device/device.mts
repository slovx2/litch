// 一台设备：一条连接，加上连上之后要做的事。
// 对面有两种：
// - 一个普通的 Codex 服务（原生 codex，或适配器的一个入口）：单 harness 模式，这是基础层；
// - 设备服务的聚合面，一条连接里有多个 harness：完整模式，在基础层上多了 harness 这个维度——
//   每个会话记着自己属于哪个 harness；不带会话标识的请求要指明发给哪个；某个 harness 可以单独不可用、
//   单独恢复，恢复之后它的会话列表要补取、它上面打开着的会话要重新订阅。
// 握手之后问一次 runtime/info 来认。对面没声明的扩展连参数都不带。
// 数据流的纪律：通知按白名单路由；连接健康时通知是唯一的数据来源；
// 只在刚连上、重连之后、手动刷新这三个时机做全量对账。

import type {
  ClientToolCallResponse,
  ClientToolsDesktopInfo,
} from '../../../protocol/src/client-tools.mjs'
import { CONFIG_NAMESPACE } from '../../../protocol/src/client-tools-config.mjs'
import type { MachineSpecContext } from '../../../protocol/src/client-tools-machine.mjs'
import { presentationSpec } from '../../../protocol/src/client-tools-presentation.mjs'
import { clientToolSpecs } from '../../../protocol/src/client-tools-specs.mjs'
import {
  CLIENT_TOOL_NAMESPACE,
  type ClientInfo,
  DEVICE_SETTINGS_CHANGED,
  type DeviceSettingsChangedNotification,
  EXTENSION,
  isUnknownMethodError,
  type LitchBackground,
  type Model,
  type ModelListResponse,
  PINNED_SECTION_ID,
  type Project,
  type ProjectListResponse,
  SESSION_TREE_METHOD,
  type ServerNotificationMethod,
  type ServerNotifications,
  type SessionTreeThreadFields,
  type Thread,
  type ThreadListSkippedHarness,
  type ThreadSectionListResponse,
  type Turn,
} from '../../../protocol/src/index.mjs'
import { taskCardsSettingKey } from '../../../protocol/src/session-tree.mjs'
import { ChannelError, type Clock, type SidebarOp } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { createLink, type LinkState } from '../connection/link.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type { TransportOpener } from '../connection/transport.mjs'
import type { MachineDeviceLink, MachineSessionAsk } from '../machine-wiring.mjs'
import type {
  ComposeOptions,
  ConnectFailureView,
  ConnectionState,
  DeviceView,
  HarnessAbilities,
  HarnessId,
  HarnessSwitches,
  HarnessView,
  OutgoingMessage,
  RemoteTarget,
  SectionView,
  SessionDefaults,
  SessionSettings,
  SessionSummary,
  SidebarView,
  ToolSwitches,
  WireColor,
  WorkspaceView,
} from '../model.mjs'
import type { ToolAnswer, ToolInvocation } from '../model-client-tools.mjs'
import type { GoalChange } from '../model-goal.mjs'
import type { MachineAccessView } from '../model-machine.mjs'
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
import type {
  AgentThreadView,
  LineageKind,
  OfferChoice,
  ProposalOverrides,
  SandboxLevel,
} from '../model-tree.mjs'
import { phrase, sameText, type Text } from '../phrase.mjs'
import type { RequestChoice } from '../projection/requests.mjs'
import { projectService, projectUpgrade } from '../projection/service.mjs'
import { isAgentThread, parentOf, projectSummary, threadTitle } from '../projection/session.mjs'
import { composeOptions, projectDefaults } from '../projection/settings.mjs'
import type { SkillCatalog } from '../projection/skills.mjs'
import { pathTwin, samePath } from '../text/paths.mjs'
import type { ToolHub } from '../tool-hub.mjs'
import { createAgentThreads } from './agents.mjs'
import { collectThreads, type Listing, mergeListing } from './catalog.mjs'
import { createComposeAids } from './compose.mjs'
import { createDiffs, type Diffs } from './diffs.mjs'
import { createExec } from './exec.mjs'
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
import {
  type AuthForwardPlatform,
  createHarnessConfig,
  type HarnessConfig,
} from './harness-config.mjs'
import { createInstall, type Install } from './install.mjs'
import { createLiveSessions } from './live.mjs'
import type { MachineFacts } from './machine/types.mjs'
import { createManagement } from './manage.mjs'
import { createOrganizer, looseDirectories, type Organizer } from './organize.mjs'
import { createPairing, type Pairing, type PairingPlatform } from './pairing.mjs'
import { DEFAULT_TOOL_SWITCHES } from './remote.mjs'
import type { SnapshotStore } from './snapshot.mjs'
import { createTasks, type Tasks } from './tasks.mjs'
import type { TerminalNotesStore } from './terminal-launch.mjs'
import { createTerminals, type Terminals } from './terminals.mjs'
import {
  type ConfigCallInput,
  clientAskOptions,
  createToolCalls,
  type MachineCallInput,
  type ToolAskPlace,
} from './tool-calls.mjs'
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
  /**
   * 这台设备的两个开关现在是什么：harness 给了是这个 harness 的（没单独设过的跟设备一级），null 是设备一级的。
   * 不给按默认：浏览器开、Computer Use 关
   */
  toolSwitches?(harness: HarnessId | null): { browser: boolean; computer: boolean }
  /** litch_machine：远程设备上的会话操作这台电脑。只有远程设备、核心有执行器时给 */
  machine?: DeviceMachine
  /** 扫码绑定手机要碰 ssh、文件、端口的那几样（外壳给）。不给就出不了码，已绑定的手机照样能看、能撤 */
  pairing?: PairingPlatform
  /** harness 登录的回调要经 ssh 转到远程设备时用（外壳给）。不给就转不了，界面照实说 */
  forward?: AuthForwardPlatform
  /**
   * litch_config：本机 harness 里跑的 litch config 经设备进程交过来的调用（核心的执行器，config/executor.mts）。
   * 只有本机设备给：握手时声明这个命名空间，但不放进建会话的 dynamicTools
   */
  config?(input: ConfigCallInput): Promise<ClientToolCallResponse>
  /** 握手时报的这台桌面端（本机设备声明 litch_config 时用；远程设备的在 machine.desktop 里） */
  desktop?: ClientToolsDesktopInfo
  log?(line: string): void
}

/** 一台远程设备上 litch_machine 的那几样，由核心给（machine-wiring.mts 的接线） */
export interface DeviceMachine {
  /** 设备设置页上“操作这台电脑”一项的现值 */
  view(): MachineAccessView
  /** 握手时报给对面的这台桌面端；system 是建会话时写进说明的 */
  desktop: ClientToolsDesktopInfo & { system: string }
  /** 一次调用。session：放进会话对话里的卡片，找不到会话是 null */
  call(input: MachineCallInput, session: MachineSessionAsk | null): Promise<ClientToolCallResponse>
  turnEnded(threadId: string, turnId: string): void
  /** 连上了、断开了（断开太久执行器会结束这台设备发起的进程） */
  presence(online: boolean): void
}

export { DEFAULT_TOOL_SWITCHES } from './remote.mjs'

/** 建会话时、调用时按开关管的两个命名空间，各对应开关里的哪一项 */
const SWITCHED: Record<string, 'browser' | 'computer'> = {
  [CLIENT_TOOL_NAMESPACE.browser]: 'browser',
  [CLIENT_TOOL_NAMESPACE.computer]: 'computer',
}

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
    /** message 的文字是持续目标：建好后设下目标，不发消息（live.mts 的 create） */
    asGoal?: boolean,
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
  /** now：有回合在进行时直接插进去，插不进去就照常排队 */
  send(sessionId: string, message: OutgoingMessage, now?: boolean): Promise<void>
  steer(sessionId: string, messageId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  unqueue(sessionId: string, messageId: string): void
  respond(sessionId: string, requestId: string, choice: RequestChoice): void
  fork(sessionId: string, turnId: string): Promise<string>
  rollback(sessionId: string, turnId: string): Promise<void>
  compact(sessionId: string): Promise<void>
  /** 设、改、清持续目标（live.mts 的 setGoal、clearGoal） */
  setGoal(sessionId: string, change: GoalChange): Promise<void>
  clearGoal(sessionId: string): Promise<void>
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
  /** 这台设备上的定时任务：订阅、建、改、删、立即运行、运行记录（tasks.mts） */
  readonly tasks: Tasks
  /** 这台设备上的扫码绑定手机：出码、确认、已绑定的手机（pairing.mts） */
  readonly pairing: Pairing
  /** 这台设备上给 harness 安装：版本、安装任务（install.mts） */
  readonly install: Install
  /** 这台设备上各 harness 的详情设置：配置项、账号与 provider、MCP、指令文件（harness-config.mts） */
  readonly harnessConfig: HarnessConfig
  /** litch_machine 把这台设备当作一台能操作的机器时用的：它的连接 */
  readonly machineLink: MachineDeviceLink
  /** 现查这台设备的情况（主机名、系统、用户、主目录、shell），缓存一会儿。没连着时抛错 */
  machineFacts(): Promise<MachineFacts>
  /** litch_machine 的开关关掉了：进行中的调用都回失败，挂着的卡片撤掉 */
  stopMachine(response: ClientToolCallResponse): void
  /** 会话树：在 parentId 下面派一个 Litch 子会话，返回它的标识。设备没有会话树时抛 unsupported */
  spawn(request: SpawnRequest): Promise<string>
  /** 会话树：把子会话脱离成独立会话 */
  detach(sessionId: string): Promise<void>
  /** 会话树：提案上点了“开始”（overrides 是“改了再开始”改过的那几项），返回起出来的子会话 */
  acceptProposal(
    sessionId: string,
    proposalId: string,
    overrides?: ProposalOverrides,
  ): Promise<string>
  /** 会话树：提案上点了“不要” */
  dismissProposal(sessionId: string, proposalId: string): Promise<void>
  /** 用户在 offer 卡上选了“新会话”（session）或“在这里做”（here） */
  answerProposal(sessionId: string, proposalId: string, choice: OfferChoice): Promise<void>
  /** 普通提案卡上的“在这里做”：设备进程往父会话发标题加任务（在跑就排到回合后） */
  hereProposal(sessionId: string, proposalId: string, lead?: string): Promise<void>
  /** 这个会话下面引擎自己的子代理线程（直接的子女） */
  agents(sessionId: string): Promise<AgentThreadView[]>
}

/** 用户在界面上派子会话时选的（channel 上 session.spawn 的参数去掉设备） */
export interface SpawnRequest {
  parentId: string
  harness?: string
  model?: string
  effort?: string
  workspaceId?: string
  cwd?: string
  kind: LineageKind
  title: string
  prompt: string
  /** 任务之前的背景（全新开始时单成一段交给子会话；带上下文的不用）。空的不带 */
  background?: string
  wakeParent: boolean
  sandbox?: SandboxLevel
}

/** 沙箱档配的审批策略（和内置的三档权限预设一样：完全访问不问，别的按需问） */
const sandboxParams = (sandbox: SandboxLevel | undefined) =>
  sandbox
    ? { sandbox, approvalPolicy: sandbox === 'danger-full-access' ? 'never' : 'on-request' }
    : {}

// —— litch_machine：现查一台设备的情况（08 号 2.4 的 machines、说明开头那两句） ——

/** 一行一项：主机名、内核、架构、用户、主目录、shell、macOS 的版本号（别的系统是空行） */
const FACTS_SCRIPT = [
  'hostname 2>/dev/null || uname -n',
  'uname -s',
  'uname -m',
  'id -un 2>/dev/null || whoami',
  'printf "%s\\n" "$HOME"',
  'printf "%s\\n" "${SHELL:-}"',
  'sw_vers -productVersion 2>/dev/null || echo',
].join('\n')
const FACTS_TIMEOUT_MS = 5000
/** 查到的记多久 */
const FACTS_TTL_MS = 60_000

/** 给人看的主机标识里去掉用户名，剩下的当主机名 */
const hostOf = (label: string): string => label.slice(label.lastIndexOf('@') + 1)

/** 握手时知道的系统（macos、linux、windows）换成给模型看的写法 */
const osName = (os: string | null): string =>
  os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'windows' ? 'Windows' : (os ?? '')

/** 比如 macOS 26.5 arm64、Linux x86_64 */
const systemOf = (kernel: string, release: string, arch: string): string => {
  if (!kernel) return ''
  const base = kernel === 'Darwin' ? `macOS${release ? ` ${release}` : ''}` : kernel
  return arch ? `${base} ${arch}` : base
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
  | 'thread/tokenUsage/updated'
  | 'thread/reverted'
  | 'thread/settings/updated'
  // 持续目标设了、改了、清了：上游发给每条连接，这一版只给打开着的那个会话（live.mts），侧栏不标
  | 'thread/goal/updated'
  | 'thread/goal/cleared'
  // 导进来的会话被别处占上、放开：只关系打开着的那个会话能不能写（live.mts）
  | 'litch/thread/nativeOwner/changed'
  // harness 详情设置的通知不归会话目录（harness-config.mts）
  | 'litch/harness/config/changed'
  | 'litch/harness/auth/updated'
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
  /** 对面支不支持定时任务（deviceTasks 扩展）。认出来之前、对面不是设备服务时都是不支持 */
  let schedulable = false
  /**
   * 对面有没有会话树（sessionTree 扩展：Litch 子会话、提案、litch_sessions）。认出来之前、对面不是设备服务时都是没有；
   * 断开之后留着断开前知道的
   */
  let sessionTree = false
  /** 对面支不支持扫码绑定手机（devicePairing 扩展）。断开之后留着断开前知道的 */
  let pairable = false
  /** 对面支不支持给 harness 安装（harnessInstall 扩展）。断开之后留着断开前知道的 */
  let installable = false
  /** 对面支不支持 harness 详情设置（harnessConfig 扩展，设备那一级）。断开之后留着断开前知道的 */
  let configurable = false
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
  /** 这台设备上的组（自定义分区，不含置顶），按建的先后 */
  let sections: SectionView[] = []
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
    sections = remembered.sections
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
  /** 设备服务报的主机名（runtime/info 的 device.hostname）。单个入口不报，是 null */
  let deviceHostname: string | null = null
  /** 设备服务报的时区（runtime/info 的 device.timezone，支持定时任务的才报）。不知道是 null */
  let deviceZone: string | null = null

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
    timezone: deviceZone,
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
    // 远程设备“操作这台电脑”：本机设备、执行不了的桌面端是 null
    machine: options.machine?.view() ?? null,
    sessionTree,
    pairing: pairable,
    install: installable,
  })

  /**
   * 设备设置里各项现在的值：有人订阅着设置（manage.mts）时才有，没人看就是 null。
   * 只用来读任务卡按 harness 的开关
   */
  let settingValues: Record<string, unknown> | null = null
  /** 这个 harness 的任务卡开着没有。没连着、没人看着设置、旧设备服务没有这一项都是 null */
  const taskCardsOf = (harness: HarnessId): boolean | null => {
    const value = online ? settingValues?.[taskCardsSettingKey(harness)] : undefined
    return typeof value === 'boolean' ? value : null
  }

  /** 两个开关现在是什么：harness 是 null 时是设备一级的 */
  const switchesOf = (harness: HarnessId | null) =>
    options.toolSwitches?.(harness) ?? DEFAULT_TOOL_SWITCHES

  /**
   * 设置页上的开关：设备一级的两个（这台桌面执行不了的那一项是 null，不出开关），
   * 和设备声明的每个 harness 的三样（任务卡读设备设置，浏览器、Computer Use 存在桌面端）
   */
  const toolSwitchesView = (): ToolSwitches => {
    const can = options.tools?.namespaces() ?? []
    const now = switchesOf(null)
    const each: Record<string, HarnessSwitches> = {}
    for (const entry of harnesses) {
      const own = switchesOf(entry.id)
      each[entry.id] = {
        taskCards: taskCardsOf(entry.id),
        browser: own.browser,
        computer: own.computer,
      }
    }
    return {
      browser: can.includes(CLIENT_TOOL_NAMESPACE.browser) ? now.browser : null,
      computer: can.includes(CLIENT_TOOL_NAMESPACE.computer) ? now.computer : null,
      harnesses: each,
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
      task: tasks.mark(thread.id),
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
    sections,
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
          sections,
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
  /**
   * 见过的引擎自己的子代理线程（parentThreadId、来历是由别的线程派出）：不进侧栏。原生 codex 的子线程跑起来时
   * 会把状态通知发给每条连接，不认出来的话它会被当成“别处建的会话”要来放进侧栏，过一会儿对账又没了。
   * 记下它的会话对象和最近的一个回合（答“这是不是子代理”，给父会话一份带状态的子代理列表），删掉了就忘掉。
   * 列表变了就交给开着的父会话（session.agents）
   */
  const agentThreads = createAgentThreads((parentId) =>
    live.setAgents(parentId, agentThreads.list(parentId)),
  )

  const upsertThread = (thread: Thread) => {
    if (thread.ephemeral) {
      transient.add(thread.id)
      return
    }
    if (isAgentThread(thread)) {
      agentThreads.put(thread)
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
    if (
      !thread.ephemeral &&
      !isAgentThread(thread) &&
      titleless(thread) &&
      !threads.has(thread.id)
    ) {
      unspoken.add(thread.id)
      return
    }
    upsertThread(thread)
  }

  const removeThread = (threadId: string) => {
    agentThreads.forget(threadId)
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

  const patchThread = (
    threadId: string,
    patch: Partial<Thread> & {
      litchLineage?: SessionTreeThreadFields['litchLineage'] | undefined
      litchBackground?: LitchBackground | undefined
    },
  ) => {
    if (transient.has(threadId)) return
    if (agentThreads.has(threadId)) {
      agentThreads.patch(threadId, patch)
      return
    }
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

  /** 取组（自定义分区）的列表，置顶那个不算。对面没有项目这组方法时也不会有组 */
  const loadSections = async (): Promise<SectionView[]> => {
    if (hasProjects !== true) return []
    const all: SectionView[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result: ThreadSectionListResponse = await link.request(
          'threadSection/list',
          cursor ? { cursor } : {},
        )
        for (const entry of result.data) {
          if (entry.id !== PINNED_SECTION_ID) all.push({ id: entry.id, name: entry.name })
        }
        if (!result.nextCursor || result.nextCursor === cursor) break
        cursor = result.nextCursor
      }
    } catch (error) {
      // 有项目、没有分区这组方法的对面：当它没有组
      if (!(error instanceof RpcError) || !isUnknownMethodError(error.code)) throw error
      return []
    }
    return all
  }

  /** 换上新取的工作区和组。工作区上记着的组要对着组的列表认（workspaces.mts） */
  const setWorkspaces = (projects: Project[], listed: SectionView[]) => {
    sections = listed
    workspaces = projectWorkspaces(projects, new Set(listed.map((entry) => entry.id)))
    rawProjects = projects
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
    for (const [id, thread] of next) {
      // 列表里混进来的子代理线程（不按上游的默认排除它们的入口）也不进侧栏
      if (isAgentThread(thread)) agentThreads.put(thread)
      else threads.set(id, thread)
    }
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
   * 一个 harness 恢复可用了：它上面打开着的会话重新订阅——之前的订阅随它的
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

  /** 设备那一级没声明 harnessConfig 的，harness 自己声明了也不算 */
  const withConfig = (harness: HarnessView): HarnessView =>
    harness.configurable && !configurable ? { ...harness, configurable: false } : harness

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
    const next = withConfig(harnessFromInfo(info))
    remember(id, termsOf(info))
    const at = harnesses.findIndex((entry) => entry.id === id)
    const wasReady = harnesses[at]?.state === 'ready'
    harnesses = at < 0 ? [...harnesses, next] : harnesses.with(at, next)
    if (next.state === 'ready') {
      // 取目录时它被跳过了的话，就算我们这边一直当它可用，也要补取
      if (!wasReady || gaps.has(id)) void recover(id)
      // 重新起来了（改了环境变量之后设备自己重启的也算）：详情设置里开着的那几块重读，
      // 新的环境变量、配置这时才读得到
      if (!wasReady && at >= 0) harnessConfig.restarted(id)
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
      // 认出来了的子代理线程：只记状态，不去要、不进侧栏
      if (agentThreads.has(threadId)) {
        patchThread(threadId, { status })
        return
      }
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
    // 组本身建了、改了、删了：组的列表和工作区一起重新取（工作区上记着的组要对着它认）。
    // 里面的会话各自会有上面那条通知
    'litch/threadSection/changed': () => {
      if (hasProjects === true) void refreshProjects()
    },
    'litch/harness/status/changed': harnessChanged,
    // 会话树：一个会话的 Litch 父子关系建立了、脱离了。只发给声明了 sessionTree 的连接
    'litch/thread/lineage/updated': ({ threadId, lineage }) =>
      patchThread(threadId, { litchLineage: lineage ?? undefined }),
    // 后台任务的集合变了（整份）。只发给声明了 backgroundTasks 的连接；没打开过的会话也发，侧栏要标
    'litch/thread/background/changed': ({ threadId, tasks, wakesOnFinish }) =>
      patchThread(threadId, {
        litchBackground: tasks.length > 0 ? { tasks, wakesOnFinish } : undefined,
      }),
  }

  const route = (method: string, params: unknown) => {
    const handler = (routes as Record<string, ((params: never) => void) | undefined>)[method]
    if (handler) {
      handler(params as never)
    } else if (live.notification(method, params)) {
      // 会话里的事，已经交给打开着的那个会话了。子代理线程的回合开始、结束另记一份：
      // 父会话的子代理列表照它写状态，子线程自己开没开着都一样
      if (method === 'turn/started' || method === 'turn/completed') {
        const { threadId, turn } = params as { threadId: string; turn: Turn }
        if (agentThreads.has(threadId)) agentThreads.turn(threadId, turn)
      }
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
      const listed = await loadSections()
      // 完整模式下这是各个 harness 合并后的列表；当时不可用的 harness 不在里面，它上次的会话留着
      const listing = await loadThreads()
      // 界面要过已归档的那张表：对账时一起重新取
      const shelved = archived ? await loadThreads(true) : null
      if (mine !== session) return
      setWorkspaces(projects, listed)
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
      const listed = await loadSections()
      if (mine !== session) return
      setWorkspaces(projects, listed)
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
        configurable = info.device.extensions?.includes(EXTENSION.harnessConfig) === true
        harnesses = info.harnesses.map((entry) => withConfig(harnessFromInfo(entry)))
        for (const entry of info.harnesses) remember(entry.id, termsOf(entry))
        // 设置接口有没有，看它声明的扩展，不看版本号
        manageable = info.device.extensions?.includes(EXTENSION.deviceSettings) === true
        reattachable = info.device.extensions?.includes(EXTENSION.deviceProcesses) === true
        schedulable = info.device.extensions?.includes(EXTENSION.deviceTasks) === true
        sessionTree = info.device.extensions?.includes(EXTENSION.sessionTree) === true
        pairable = info.device.extensions?.includes(EXTENSION.devicePairing) === true
        installable = info.device.extensions?.includes(EXTENSION.harnessInstall) === true
        // 在跑的是哪一份服务：握手时声明过才给，旧版的设备服务不报
        service = projectService(info.device.service)
        serviceDue =
          service === null && info.device.extensions?.includes(EXTENSION.deviceService) === true
        home = typeof info.device.home === 'string' ? info.device.home : null
        platform = info.device.os ?? null
        deviceHostname = typeof info.device.hostname === 'string' ? info.device.hostname : null
        deviceZone = typeof info.device.timezone === 'string' ? info.device.timezone : null
      } else {
        // 上一次连的是设备服务的话，那时认的不算数：单个入口有没有这组方法要问了才知道
        if (mode === 'full') hasProjects = null
        remember(harnessFromRuntimeInfo(info).id, termsOf(info))
        mode = 'single'
        harnesses = [harnessFromRuntimeInfo(info)]
        manageable = false
        reattachable = false
        schedulable = false
        sessionTree = false
        pairable = false
        installable = false
        configurable = false
        service = null
        home = null
        deviceHostname = null
        deviceZone = null
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
      schedulable = false
      sessionTree = false
      pairable = false
      installable = false
      configurable = false
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
    if (options.machine) {
      options.machine.presence(true)
      // 先查一遍这台设备的情况，建会话时说明里写得准一些（查不到就按握手时知道的写）
      machineFacts().catch(() => {})
    }
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
    tasks.resync()
    pairing.resync()
    install.resync()
    harnessConfig.resync()
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
      if (dropped) machineExec.offline()
      if (dropped) machineFactsCache = null
      if (dropped) options.machine?.presence(false)
      if (dropped) live.offline()
      if (dropped) terminals.offline()
      if (dropped) files.offline()
      if (dropped) diffs.offline()
      manage.offline()
      tasks.offline()
      pairing.offline()
      install.offline()
      harnessConfig.offline()
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
    // 握手时声明的：建会话时带的那些，加上只走命令行的 litch_config（本机设备才有）
    clientTools: () => [...toolNamespaces(), ...(options.config ? [CONFIG_NAMESPACE] : [])],
    clientToolsDesktop: () => {
      const desktop = options.machine?.desktop ?? (options.config ? options.desktop : undefined)
      return desktop ? { hostname: desktop.hostname, name: desktop.name ?? desktop.hostname } : null
    },
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
      // 定时任务：一样和会话目录是两回事，任务模块自己对账、自己攒
      if (tasks.notification(method, params)) return
      // 扫码绑定手机：配对的状态、已绑定的手机
      if (pairing.notification(method, params)) return
      // 给 harness 安装：任务的状态和日志
      if (install.notification(method, params)) return
      // harness 详情设置：配置变了、登录有进展
      if (harnessConfig.notification(method, params)) return
      // 差异面板在设备上跑的命令结束了、它盯着的路径变了：先认它自己起的那些，剩下的进程通知才是终端的
      if (diffs.notification(method, params)) return
      // litch_machine 起的进程（执行器的、现查设备情况的）也不是终端的
      if (machineExec.notification(method, params)) return
      if (machineProcess(method, params)) return
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
    agentsOf: (sessionId) => agentThreads.list(sessionId),
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
      // 按声明给：引擎在 runtime/info 的 extensions 里报了 clientTools 才带（dsh 不认这个参数；
      // 还没接上客户端工具的引擎也不报）。没有声明的是更早的适配器，那时只有 dsh 不认
      const declared = harness === null ? undefined : terms.get(harness)
      if (declared ? !declared.extensions.includes(EXTENSION.clientTools) : harness === 'dsh') {
        return null
      }
      // litch_machine 的说明按会话生成：开头写这个会话在哪台、桌面端是哪台；litch_computer 的说明按桌面的平台挑。
      // litch_tasks、litch_sessions 的执行方是设备服务自己：设备列了 deviceTasks、声明了会话树就各自带上，
      // 和这台桌面能执行什么无关（握手时不声明它们，toolNamespaces 里也没有）。
      // 最后是呈现风格（不带工具，只有 instructions；原生 codex 不带，client-tools-presentation.mts）
      // 内置浏览器、Computer Use 在这个 harness 上关着的不带（模型看不到，也省提示词）；调用时还会再查一次
      const presentation = presentationSpec(harness)
      const now = switchesOf(harness)
      return [
        ...clientToolSpecs(
          [
            ...toolNamespaces().filter((namespace) => {
              const which = SWITCHED[namespace]
              return which === undefined || now[which]
            }),
            ...(schedulable ? [CLIENT_TOOL_NAMESPACE.tasks] : []),
            ...(sessionTree ? [CLIENT_TOOL_NAMESPACE.sessions] : []),
          ],
          {
            machine: machineSpec(),
            desktopPlatform: options.tools?.platform?.() ?? null,
          },
        ),
        ...(presentation ? [presentation] : []),
      ]
    },
    sessionTree: () => sessionTree,
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
      notify: () => {},
      config: async () => ({ ok: false, reason: 'no desktop shell' }),
    },
    device: (): ToolInvocation['device'] => ({
      id: config.id,
      // 核心不认识语言：本机的名字是一句“本机”，给执行器的是主机标识
      name: typeof name === 'string' ? name : config.host,
      kind: config.kind,
      target: sshTarget(config.target),
    }),
    allowed(namespace, harness) {
      const which = SWITCHED[namespace]
      return which === undefined || switchesOf(harness)[which]
    },
    context(threadId) {
      const thread = threads.get(threadId) ?? archived?.get(threadId)
      return {
        harness: thread ? harnessOf(thread) : mode === 'full' ? null : (harnesses[0]?.id ?? null),
        cwd: thread?.cwd || null,
      }
    },
    showAsk: (place: ToolAskPlace, answer) => askInSession(place, (picked) => answer(picked)),
    ...(options.machine ? { machine: machineCalls(options.machine) } : {}),
    ...(options.config ? { config: options.config } : {}),
    log,
  })

  /**
   * 在会话的对话里出一张客户端工具的卡片（和审批卡片同一处），侧栏那一行打上“等待”。
   * 用户答了、或者卡片被撤了（null）调 answer；返回的函数撤掉卡片
   */
  const askInSession = (
    place: ToolAskPlace,
    answer: (picked: ToolAnswer | null, note: string | null) => void,
  ): (() => void) => {
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
    const drop = live.clientAsk(place, request, (picked, note) => {
      uncount()
      answer(picked, note)
    })
    return () => {
      uncount()
      drop()
    }
  }

  /** litch_machine 的卡片编号（和主进程给的卡片标识分开） */
  let machineAskSeq = 0

  /**
   * litch_machine 的调用交给核心的接线。卡片放哪（08 号 4.2）：回合里的调用、命令行调用里会话在这台设备上找得到的，
   * 放进那个会话的对话；找不到会话的交给接线放进全局待处理
   */
  function machineCalls(machine: DeviceMachine) {
    return {
      call(input: MachineCallInput) {
        const { threadId } = input
        const known =
          threadId !== null &&
          (input.turnId !== null || threads.has(threadId) || archived?.has(threadId) === true)
        const session: MachineSessionAsk | null =
          known && threadId !== null
            ? (ask, answer) =>
                askInSession(
                  {
                    threadId,
                    turnId: input.turnId ?? '',
                    callId: input.callId,
                    askId: `machine-${config.id}-${++machineAskSeq}`,
                    namespace: CLIENT_TOOL_NAMESPACE.machine,
                    tool: input.tool,
                    ask,
                  },
                  answer,
                )
            : null
        return machine.call(input, session)
      },
      turnEnded: (threadId: string, turnId: string) => machine.turnEnded(threadId, turnId),
    }
  }

  // —— litch_machine：这台设备作为“会话所在的那台”时用的 ——

  /** 建会话时声明、握手时报的命名空间：主进程能执行的，加上核心自己执行的 litch_machine（只有远程设备） */
  const toolNamespaces = (): string[] => [
    ...(options.tools?.namespaces() ?? []),
    ...(options.machine ? [CLIENT_TOOL_NAMESPACE.machine] : []),
  ]

  /** 执行器在这条连接上起的进程的通知交给它们（MachineTarget.onProcessNotification） */
  const machineWatchers = new Set<(method: string, params: unknown) => boolean>()
  const machineProcess = (method: string, params: unknown): boolean => {
    if (method !== 'process/outputDelta' && method !== 'process/exited') return false
    for (const watcher of [...machineWatchers]) if (watcher(method, params)) return true
    return false
  }

  const machineLink: MachineDeviceLink = {
    online: () => online,
    request(method, params, requestOptions) {
      if (!online) return Promise.reject(new ChannelError('offline', '设备没有连上'))
      return link.request(method, params, requestOptions)
    },
    onProcessNotification(handler) {
      machineWatchers.add(handler)
      return () => {
        machineWatchers.delete(handler)
      }
    },
  }

  /** 现查设备情况用的（不经 shell 起 sh，输出很短） */
  const machineExec = createExec({
    clock: options.clock,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
  })
  let machineFactsCache: { at: number; facts: MachineFacts } | null = null
  let machineFactsLoading: Promise<MachineFacts> | null = null

  const probeFacts = async (): Promise<MachineFacts> => {
    const label = typeof name === 'string' ? name : config.host
    let lines: string[] = []
    try {
      const result = await machineExec.run(['sh', '-c', FACTS_SCRIPT], {
        cwd: home ?? '/',
        capBytes: 8192,
        timeoutMs: FACTS_TIMEOUT_MS,
      })
      if (result.exitCode === 0) lines = result.stdout.split('\n').map((line) => line.trim())
    } catch (error) {
      log(`查设备情况没成：${String(error)}`)
    }
    const [hostname, kernel, arch, user, homeDir, shell, release] = lines
    const facts: MachineFacts = {
      name: label,
      hostname: hostname || deviceHostname || hostOf(config.host),
      system: systemOf(kernel ?? '', release ?? '', arch ?? '') || osName(platform),
      user: user ?? '',
      home: homeDir || home || '',
      shell: shell ?? '',
    }
    // 查到了才记着；没查到的这一次凑合用，下次再查
    if (lines.length > 0) machineFactsCache = { at: options.clock.now(), facts }
    return facts
  }

  const machineFacts = (): Promise<MachineFacts> => {
    if (!online) return Promise.reject(new ChannelError('offline', '设备没有连上'))
    const cached = machineFactsCache
    if (cached && options.clock.now() - cached.at < FACTS_TTL_MS) {
      return Promise.resolve({
        ...cached.facts,
        name: typeof name === 'string' ? name : config.host,
      })
    }
    machineFactsLoading ??= probeFacts().finally(() => {
      machineFactsLoading = null
    })
    return machineFactsLoading
  }

  /** 建会话时写进 litch_machine 说明的两台。不知道这台的主机名时是 null，说明里不写具体的机器 */
  const machineSpec = (): MachineSpecContext | null => {
    const machine = options.machine
    if (!machine) return null
    const known = machineFactsCache?.facts
    const hostname = known?.hostname || deviceHostname || hostOf(config.host)
    if (!hostname) return null
    return {
      session: {
        name: typeof name === 'string' ? name : config.host,
        hostname,
        system: known?.system || osName(platform),
      },
      desktop: {
        name: machine.desktop.name ?? machine.desktop.hostname,
        hostname: machine.desktop.hostname,
        system: machine.desktop.system,
      },
    }
  }

  const organize = createOrganizer({
    online: () => online,
    capable: () => hasProjects === true,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    projects: () => rawProjects,
    sections: () => sections,
    reload: () => refreshProjects(),
    thread: (sessionId) => threads.get(sessionId),
    put: (thread) => upsertThread(thread),
    now: () => options.clock.now(),
  })

  const tasks = createTasks({
    deviceId: config.id,
    online: () => online,
    supported: () => schedulable,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    marksChanged(threadIds) {
      const ops: SidebarOp[] = []
      for (const threadId of threadIds) {
        const thread = threads.get(threadId)
        if (thread) ops.push({ op: 'session.upsert', session: summaryOf(thread) })
      }
      if (ops.length > 0) hooks.sidebarOps(ops)
    },
    log,
  })

  const pairing = createPairing({
    deviceId: config.id,
    kind: config.kind,
    target: () => config.target,
    displayName: () => (typeof name === 'string' ? name : config.host),
    online: () => online,
    supported: () => pairable,
    platform: options.pairing ?? null,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    log,
  })

  const install = createInstall({
    deviceId: config.id,
    now: () => options.clock.now(),
    online: () => online,
    supported: () => installable,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    log,
  })

  const harnessConfig = createHarnessConfig({
    deviceId: config.id,
    target: () => config.target,
    online: () => online,
    deviceSupported: () => configurable,
    harnessSupported: (harness) =>
      mode === 'full' && harnesses.find((entry) => entry.id === harness)?.configurable === true,
    configurable: () =>
      mode === 'full'
        ? harnesses.filter((entry) => entry.configurable).map((entry) => entry.id)
        : [],
    nameOf: (harness) => harnessName(harness),
    forward: options.forward ?? null,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    now: () => options.clock.now(),
    log,
  })

  const manage = createManagement({
    deviceId: config.id,
    online: () => online,
    supported: () => manageable,
    request: (method, params, requestOptions) => link.request(method, params, requestOptions),
    fail: (error) => fail(error),
    // 任务卡按 harness 的开关存在设备上：不为它另外去读，有人看着设置（设置页那棵树、设备详情）时跟着那一份走
    viewed(snapshot) {
      const before = JSON.stringify(settingValues)
      settingValues = snapshot ? { ...snapshot.values } : null
      if (JSON.stringify(settingValues) !== before) hooks.device(view())
    },
    log,
  })

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
        return first !== undefined && samePath(first, root)
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
    if (workspaces.some((workspace) => workspace.roots.some((entry) => samePath(entry, root)))) {
      return true
    }
    for (const thread of threads.values()) if (samePath(thread.cwd, root)) return true
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

  // —— 会话树（sessionTree 扩展） ——

  /** 会话树的那几件事：设备没声明就做不了，连不着也做不了 */
  const treeOnly = () => {
    if (!online) throw new ChannelError('offline', '设备没有连上')
    if (!sessionTree) throw new ChannelError('unsupported', '这台设备没有会话树')
  }

  /**
   * 子会话起好了：先放进侧栏，不等对面的通知（它这时可能还没有第一句话，等通知的话要到回合开始才出现）。
   * 应答里只有标识，会话对象去要一次
   */
  const adoptChild = async (threadId: string) => {
    if (!threads.has(threadId)) await fetchThread(threadId, true)
  }

  /** 子会话归到哪个工作区：说了的照说的；没说的跟父会话一样（父会话在哪个工作区，由设备层的归属定） */
  const projectOf = (parentId: string, workspaceId: string | undefined): string | undefined => {
    if (hasProjects !== true) return undefined
    return workspaceId || threads.get(parentId)?.projectId || undefined
  }

  const spawn = async (request: SpawnRequest): Promise<string> => {
    treeOnly()
    const projectId = projectOf(request.parentId, request.workspaceId)
    const { threadId } = await guarded(() =>
      link.request(SESSION_TREE_METHOD.start, {
        parentThreadId: request.parentId,
        kind: request.kind,
        title: request.title,
        prompt: request.prompt,
        wakeParent: request.wakeParent,
        ...(request.background ? { background: request.background } : {}),
        ...(request.harness ? { harness: request.harness } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(projectId ? { projectId } : {}),
        ...sandboxParams(request.sandbox),
      }),
    )
    await adoptChild(threadId)
    return threadId
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
    openSession(sessionId, sink) {
      const close = live.open(sessionId, sink)
      // 打开了任务跑出来的会话：里面跑完的运行算看过了
      tasks.seen(sessionId)
      return close
    },
    async create(cwd, message, settings, harness, workspaceId, asGoal) {
      // 聚合面上新建会话必须说建在哪个 harness 上；别的对面没有这个参数，不带
      const target = mode === 'full' ? pickHarness(harness) : null
      // 归到哪个工作区：对面有这组方法、这个工作区也还在才带
      const home =
        workspaceId && hasProjects === true && workspaces.some((entry) => entry.id === workspaceId)
          ? workspaceId
          : null
      return live.create(cwd, message, settings, target, home, asGoal === true)
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
    send: (sessionId, message, now) => live.send(sessionId, message, now),
    steer: (sessionId, messageId) => live.steer(sessionId, messageId),
    interrupt: (sessionId) => live.interrupt(sessionId),
    unqueue: (sessionId, messageId) => live.unqueue(sessionId, messageId),
    respond: (sessionId, requestId, choice) => live.respond(sessionId, requestId, choice),
    fork: (sessionId, turnId) => live.fork(sessionId, turnId),
    rollback: (sessionId, turnId) => live.rollback(sessionId, turnId),
    compact: (sessionId) => live.compact(sessionId),
    setGoal: (sessionId, change) => live.setGoal(sessionId, change),
    clearGoal: (sessionId) => live.clearGoal(sessionId),
    markRead(sessionId) {
      if (!unread.delete(sessionId)) return
      const thread = threads.get(sessionId)
      if (thread) hooks.sidebarOps([{ op: 'session.upsert', session: summaryOf(thread) }])
      saveSoon()
    },
    openManage: (sink) => manage.open(sink),
    writeSettings: (expectedVersion, edits) => manage.write(expectedVersion, edits),
    async restartHarness(harness, force) {
      const result = await manage.restart(harness, force)
      // 要重启才生效的设置用上了：详情设置那边的提示收起、数据重读
      harnessConfig.restarted(harness)
      return result
    },
    runDiagnostics: (harness) => manage.diagnostics(harness),
    readLogs: (source, harness, maxBytes) => manage.logs(source, harness, maxBytes),
    readSshConfig: () => manage.sshConfig(),
    terminals,
    files,
    diffs,
    tasks,
    pairing,
    install,
    harnessConfig,
    machineLink,
    machineFacts,
    stopMachine: (response) => toolCalls.stopMachine(response),
    spawn,
    async detach(sessionId) {
      treeOnly()
      await guarded(() => link.request(SESSION_TREE_METHOD.detach, { threadId: sessionId }))
      // 对面成了之后会发父子关系变了的通知，不一定发给这条连接：这边先改
      patchThread(sessionId, { litchLineage: undefined })
    },
    async acceptProposal(sessionId, proposalId, overrides) {
      treeOnly()
      const { workspaceId, sandbox, ...rest } = overrides ?? {}
      // 改了项目才带：没改的让设备进程照提案、照父会话定
      const projectId = workspaceId ? projectOf(sessionId, workspaceId) : undefined
      const changed = {
        ...rest,
        ...(projectId ? { projectId } : {}),
        ...sandboxParams(sandbox),
      }
      const { threadId } = await guarded(() =>
        link.request(SESSION_TREE_METHOD.proposalAccept, {
          proposalId,
          ...(Object.keys(changed).length > 0 ? { overrides: changed } : {}),
        }),
      )
      live.settleProposal(sessionId, proposalId, 'started', threadId)
      await adoptChild(threadId)
      return threadId
    },
    async dismissProposal(sessionId, proposalId) {
      treeOnly()
      await guarded(() => link.request(SESSION_TREE_METHOD.proposalDismiss, { proposalId }))
      live.settleProposal(sessionId, proposalId, 'dismissed', null)
    },
    async answerProposal(sessionId, proposalId, choice) {
      treeOnly()
      await guarded(() => link.request(SESSION_TREE_METHOD.proposalAnswer, { proposalId, choice }))
      live.settleProposal(sessionId, proposalId, choice === 'session' ? 'chosen' : 'here', null)
    },
    async hereProposal(sessionId, proposalId, lead) {
      treeOnly()
      await guarded(() =>
        link.request(SESSION_TREE_METHOD.proposalHere, { proposalId, ...(lead ? { lead } : {}) }),
      )
      live.settleProposal(sessionId, proposalId, 'here', null)
    },
    async agents(sessionId) {
      if (!online) throw new ChannelError('offline', '设备没有连上')
      // 只要直接的子女；不给 sourceKinds 时按父会话查的返回全部来历的子线程（上游的规矩）
      const listing = await guarded(() =>
        collectThreads((cursor) =>
          link.request('thread/list', {
            limit: PAGE,
            modelProviders: [],
            parentThreadId: sessionId,
            ...(cursor ? { cursor } : {}),
          }),
        ),
      )
      // 不认识 parentThreadId 的引擎会把全部会话都回来：只留父会话确实是它的
      const own = listing.threads.filter((thread) => parentOf(thread) === sessionId)
      for (const thread of own) agentThreads.put(thread)
      // 列表里不带回合：还不知道最近一个回合的，问一下（不带条目）。问不到的（旧版的入口）就不知道，
      // 状态退回到对话里协作条目报的
      await Promise.all(
        own
          .filter((thread) => !agentThreads.knowsTurn(thread.id))
          .map(async (thread) => {
            const since = agentThreads.stamp(thread.id)
            try {
              const page = await link.request('thread/turns/list', {
                threadId: thread.id,
                limit: 1,
                sortDirection: 'desc',
                itemsView: 'notLoaded',
              })
              const last = page.data[0]
              if (last) agentThreads.settle(thread.id, last, since)
            } catch (error) {
              log(`取子代理 ${thread.id} 最近的回合失败：${String(error)}`)
            }
          }),
      )
      return agentThreads.list(sessionId)
    },
  }
}
