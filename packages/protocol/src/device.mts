// 设备服务（聚合面）的协议扩展：握手里的声明、扩展名、`runtime/info` 的应答、harness 状态变化的通知、错误，
// 以及设备级的工作区与置顶（分区变化的通知）。
// 这里的东西都不是 codex 原有的。定义的原文在仓库根目录 protocol/extensions/harness.json 和
// device-workspaces.json。规矩：扩展只增不改，扩展内容只发给声明过的连接，没改过的官方桌面端要始终能连。
//
// 这个文件只引用同样自成一体的 harness-capabilities.mts 和 device-service.mts（而且只取类型）：设备进程
// （packages/device，按 Node 的方式解析模块）和客户端核心（packages/core，按打包器的方式解析）都直接引用它。
// 和 codex 类型拼在一起的形状放在 device-codex.mts。
import type { DeviceServiceInfo } from './device-service.mjs'
import type { HarnessFeatures, PermissionPreset } from './harness-capabilities.mjs'

/**
 * 握手时 `capabilities` 里的键：客户端在这里列出自己认识的扩展名，一个扩展一个名字。
 * 是我们自己的键，不借用上游的 `extensions`（那是给 MCP 扩展设置用的）。
 */
export const EXTENSIONS_CAPABILITY = 'litchExtensions'

/** 扩展名。以后每加一个扩展在这里加一个名字，并在 protocol/extensions/ 下写一份定义 */
export const EXTENSION = {
  /**
   * 一条连接里有多个 harness：会话对象、请求、通知上的 `harness`，聚合面的 `runtime/info`，
   * 合并的会话列表，harness 状态变化的通知。聚合面要求客户端必须声明它。
   */
  harness: 'harness',
  /**
   * 设备配置接口：读写设备服务的设置、重启 harness、诊断、日志、ssh 配置片段（device-settings.mts）。
   * 设备信息的 `extensions` 里列了它才能用；声明了它的连接才会收到设置变化的通知。
   */
  deviceSettings: 'deviceSettings',
  /**
   * 拒绝审批时附一句说明（harness-capabilities.mts、extensions.mts 的 DeclineWithNoteDecision）。
   * 哪个 harness 支持看它声明里的 `extensions`；声明了它的连接才会在审批请求里看到这种决定。
   */
  declineWithNote: 'declineWithNote',
  /**
   * 设备级的工作区与置顶：聚合面上的 `project/*`、`thread/metadata/update` 的归属、`threadSection/*`、
   * `thread/section/move` 由设备层处理，数据跨 harness（定义在 protocol/extensions/device-workspaces.json）。
   * 设备信息的 `extensions` 里列了它，这几组方法在聚合面上才能用；
   * 声明了它的连接才会收到分区与置顶变化的通知（标准协议里没有这种通知）。
   */
  deviceWorkspaces: 'deviceWorkspaces',
  /**
   * 可重连的终端：进程可以属于设备，发起它的连接断开后继续运行，重连后按句柄挂回去并回放输出
   * （device-processes.mts，定义在 protocol/extensions/device-processes.json）。
   * 设备信息的 `extensions` 里列了它才能用；声明了它的连接，`process/spawn` 上的扩展参数才生效。
   */
  deviceProcesses: 'deviceProcesses',
  /**
   * 常驻服务报自己是哪一份：`runtime/info` 的 `device.service` 里是正在运行的那份适配器服务的版本、
   * 根目录、启动时间（device-service.mts，定义在 protocol/extensions/device-service.json）。
   * 设备信息的 `extensions` 里列了它，而且这条连接声明了它，才有这个字段。
   */
  deviceService: 'deviceService',
  /**
   * 计划确认由引擎在回合里问：模型交了计划，引擎自己出一道题问要不要执行，答案在这个回合里生效
   * （定义在 protocol/extensions/plan-confirmation.json）。没声明的连接照上游的做法：回合带着计划条目
   * 正常结束，要不要执行由客户端自己问，选了执行就是一个切回默认协作模式的新回合。
   * 哪个 harness 支持看它声明里的 `extensions`。
   */
  planConfirmation: 'planConfirmation',
  /**
   * 客户端工具：`litch_` 开头的命名空间的动态工具调用只交给声明过能执行它的连接，没有这样的连接时
   * 当场回失败（client-tools.mts，定义在 protocol/extensions/client-tools.json）。
   * 声明时还要在 `capabilities.litchClientTools.namespaces` 里列出能执行哪些命名空间。
   */
  clientTools: 'clientTools',
  /**
   * 定时任务：任务存在设备上、由设备服务按时执行，客户端断开也照样跑；模型可以用 litch_tasks 工具建任务
   * （device-tasks.mts、task-schedule.mts、client-tools-tasks.mts，定义在 protocol/extensions/device-tasks.json）。
   * 设备信息的 `extensions` 里列了它才能用；声明了它的连接才会收到任务和运行的变化通知。
   */
  deviceTasks: 'deviceTasks',
  /**
   * 会话树：子会话的父子关系、提案、回报与唤醒，以及由设备进程执行的 litch_sessions 工具
   * （session-tree.mts、client-tools-sessions.mts，定义在 protocol/extensions/session-tree.json）。
   * 设备信息的 `extensions` 里列了它，litch/session/*、litch/sessionProposal/* 才能用；
   * 声明了它的连接才会在会话对象上看到 litchLineage、收到相关通知。
   */
  sessionTree: 'sessionTree',
  /**
   * 扫码绑定手机：设备服务临时放行一把一次性钥匙，手机登进来登记自己的公钥（device-pairing.mts，
   * 定义在 protocol/extensions/device-pairing.json）。设备信息的 `extensions` 里列了它，litch/pair/* 才能用；
   * 声明了它的连接才会收到配对和已绑定手机的变化通知。
   */
  devicePairing: 'devicePairing',
  /**
   * 给设备装 harness：查已装、验证过的、最新的版本，按官方方式装验证版或最新版（device-harness-install.mts，
   * 定义在 protocol/extensions/harness-install.json）。设备信息的 `extensions` 里列了它，
   * litch/device/harness/versions、install、install/read 才能用；声明了它的连接才会收到安装进度的通知。
   */
  harnessInstall: 'harnessInstall',
  /**
   * harness 详情设置：每个 harness 的配置项、账号与 provider、MCP、用户级指令文件，读写的是 harness 自己的原生配置
   * （harness-config.mts，定义在 protocol/extensions/harness-config.json）。设备信息的 `extensions` 里列了它，
   * 设备进程才认 litch/device/instructions/* 并替原生 codex 翻译 litch/harness/*；别的 harness 支不支持看它声明里的
   * `extensions`。声明了它的连接才会收到配置变化和登录进展的通知。
   */
  harnessConfig: 'harnessConfig',
  /**
   * 别的应用派出的子会话：harness 自己的原生会话里，有的是别的应用（比如 Claude 桌面端）从另一个会话派出来的。
   * 会话对象上带 `litchNativeLineage` 说明是哪个应用派的（native-lineage.mts，定义在
   * protocol/extensions/native-lineage.json）。声明了它的连接才会在会话对象上看到这个字段。
   */
  nativeLineage: 'nativeLineage',
  /**
   * 后台任务：回合结束之后还在跑的工作。会话对象上带 `litchBackground`（集合），回合上带 `litchOrigin`（谁开的），
   * 集合变了发 litch/thread/background/changed（background-tasks.mts，定义在
   * protocol/extensions/background-tasks.json）。哪个 harness 会报集合看它声明里的 `features.backgroundTasks`；
   * 声明了它的连接才看得到这些字段、收得到通知。
   */
  backgroundTasks: 'backgroundTasks',
  /**
   * 别处占着的原生会话：导进来的原生会话此刻正被本机另一个进程开着（Claude 桌面端、终端），入口把它当成只读。
   * 会话对象上带 `litchNativeOwner`（占用方），占用变了发 litch/thread/nativeOwner/changed（native-owner.mts，
   * 定义在 protocol/extensions/native-owner.json）。声明了它的连接才看得到这个字段、收得到通知。
   */
  nativeOwner: 'nativeOwner',
  /**
   * 别的会话发来的消息：harness 自己的会话间消息进了对话，用户消息条目上带 `litchPeer` 说是谁发的
   * （peer-messages.mts，定义在 protocol/extensions/peer-messages.json）。声明了它的连接才看得到这个字段。
   */
  peerMessages: 'peerMessages',
  /**
   * 工作树：设备进程在会话所在的机器上建 git 工作树，新会话在里面起（worktrees.mts，定义在
   * protocol/extensions/worktrees.json）。设备信息的 `extensions` 里列了它（这台机器上有 git），litch/worktree/* 和
   * thread/start 的 `litchWorktree` 才能用；声明了它的连接才会在会话对象上看到 `litchWorktree`、收到变化通知。
   */
  worktrees: 'worktrees',
  /**
   * 手机上批准：桌面端要人点头的卡片（第一版只有内置浏览器的代理登录）经会话所在设备转给手机，手机的答复带着
   * 批准钥匙的签名交回发卡片的连接（client-approvals.mts，定义在 protocol/extensions/client-approvals.json）。
   * 设备信息的 `extensions` 里列了它，litch/approval/* 才能用；声明了它的连接才会收到卡片变化的通知，
   * 发卡片的连接要声明了它才能 open。
   */
  clientApprovals: 'clientApprovals',
  /**
   * 模型请求在重试：harness 自己重试失败的模型请求时，订阅着会话的连接收到 litch/turn/apiRetry/updated
   * （第几次、最多几次、原因；重试结束时为空），失败那次流出来的半截回答随之撤掉（api-retry.mts，
   * 定义在 protocol/extensions/api-retry.json）。声明了它的连接才收得到这个通知。
   */
  apiRetry: 'apiRetry',
} as const

export type ExtensionName = (typeof EXTENSION)[keyof typeof EXTENSION]

/** 握手时 `capabilities` 里我们加的那一部分 */
export interface LitchCapabilities {
  litchExtensions?: string[]
}

/**
 * 不可用的原因分类。以后还会加（比如没登录），客户端遇到不认识的值按一般的“不可用”处理。
 *
 * 设备进程自己判断的（它只看得到运行时的套接字）：
 * - connecting：这条连接刚建立，还在连这个运行时
 * - unreachable：连不上运行时的套接字
 * - handshakeFailed：连上了，但握手没有成功
 * - disconnected：本来连着，断了，正在重连
 *
 * 适配器主进程告诉设备进程的（运行时由它起和停，起没起来、为什么只有它知道）：
 * - starting：正在检查环境、启动
 * - disabled：在设置里停用了，或者这次启动没有选它
 * - notInstalled：没装，找不到它的命令行
 * - versionTooLow：装了，但版本低于适配器要求的下限
 * - startFailed：环境检查没过，或者没能启动
 * - stopped：起来过，后来自己退出了
 */
export type HarnessUnavailableKind =
  | 'connecting'
  | 'unreachable'
  | 'handshakeFailed'
  | 'disconnected'
  | 'starting'
  | 'disabled'
  | 'notInstalled'
  | 'versionTooLow'
  | 'startFailed'
  | 'stopped'

export interface HarnessUnavailable {
  kind: HarnessUnavailableKind
  /** 给人看的说明 */
  message: string
  /**
   * `message` 的两种语言版本。属于 deviceSettings 扩展：只有声明过它的连接才收得到，
   * 而且只有适配器主进程给的原因才有。
   */
  text?: { 'zh-CN': string; en: string }
}

/** 一个 harness 的声明和现在的状态 */
export interface HarnessInfo {
  /** 标识。别处的 `harness` 字段、参数填的都是它 */
  id: string
  displayName: string
  /** 两个字母的徽标，例如 CC、PI */
  badge: string
  /** harness 本体的版本。还没连上过、对面也没报时是 null */
  version: string | null
  /** 运行时自己报的引擎名（例如 pi、claude-code）。没报过是 null */
  engine: string | null
  available: boolean
  /** 可用时是 null */
  unavailable: HarnessUnavailable | null
  /**
   * 下面三项是这个引擎在自己的 `runtime/info` 里报的结构化声明（harness-capabilities.mts 的
   * HarnessDeclaration），聚合面原样带过来，不改不补。原生 codex 自己报不了，它的这三项由设备进程
   * 替它整理（形状一样，`extensions` 是空的）。没有声明的（旧版的适配器、还没连上过）就没有这个字段，
   * 客户端按“不知道”处理。
   */
  /** 这个引擎支持的我们自己的扩展 */
  extensions?: string[]
  features?: HarnessFeatures
  permissionPresets?: PermissionPreset[]
}

export interface DeviceInfo {
  hostname: string
  /** macos、linux、windows，和握手应答里的 platformOs 是同一个值 */
  os: string
  /** 用户主目录 */
  home: string
  /** 设备服务的版本 */
  version: string
  /** 设备服务按哪一版 Codex 协议说话 */
  protocolVersion: string
  /** 这个设备服务支持的扩展。客户端按这份列表决定能用什么，不按版本号 */
  extensions: string[]
  /**
   * 正在运行的那份适配器常驻服务的来历。属于 deviceService 扩展：只有声明过它的连接才收得到，
   * 而且要有适配器主进程在管这个设备进程、它也报了自己的来历（旧版的不报）。
   */
  service?: DeviceServiceInfo
  /**
   * 设备所在的时区（IANA 名）。属于 deviceTasks 扩展：设备服务支持定时任务时才报，
   * 客户端在定时任务的表单里按它预览“下一次”（任务没指定时区时设备按它算）
   */
  timezone?: string
}

/**
 * 聚合面上 `runtime/info` 的应答。方法名和单个运行时的那个相同（保持原名），形状不同：
 * 有 `device` 和 `harnesses` 的是设备服务，有 `engine` 的是单个运行时（见 extensions.mts）。
 */
export interface DeviceRuntimeInfo {
  device: DeviceInfo
  /** 顺序是设备上配置的顺序 */
  harnesses: HarnessInfo[]
}

/** harness 状态变化的通知。收到“恢复可用”之后，这个 harness 上打开着的会话要由客户端重新订阅 */
export const HARNESS_STATUS_CHANGED = 'litch/harness/status/changed'

export interface HarnessStatusChangedNotification {
  harness: string
  /** 变化之后的整份声明，和 `runtime/info` 里那一项同形 */
  info: HarnessInfo
}

// ---------- 设备级的工作区与置顶（扩展名 deviceWorkspaces） ----------
// 工作区用的是 Codex 协议里现成的项目（`project/*`、`project/changed`、`thread/project/updated`），
// 形状不变，只是数据存在设备层、跨 harness。协议里没有的只有下面两条通知。

/**
 * 置顶用的那个分区的标识。协议里会话没有“置顶”字段：置顶就是会话在这个固定标识的分区里
 * （`thread/section/move` 把会话放进去、`sectionId` 给 null 是拿出来）。这个值是 Codex 客户端内置的，
 * 各引擎和设备层用的是同一个。
 */
export const PINNED_SECTION_ID = '01984de2-8f74-7c91-a3b2-5c5e937cf318'

/** 会话对象上 `section` 的形状（就是协议里的 ThreadSection，这里写一份是为了不引用 codex 的类型） */
export interface DeviceThreadSection {
  id: string
  name: string
  appearance: { icon: string | null; color: string | null } | null
}

/** 一个会话进了、出了、换了分区（置顶和取消置顶也是它）。只发给声明过 deviceWorkspaces 的连接 */
export const THREAD_SECTION_UPDATED = 'litch/thread/section/updated'

export interface ThreadSectionUpdatedNotification {
  threadId: string
  /** 现在所在的分区；不在任何分区里是 null */
  section: DeviceThreadSection | null
  /** 进这个分区的时间，Unix 秒 */
  sectionEnteredAt: number | null
  isPinned: boolean
}

/** 分区本身建了、改了、删了。只发给声明过 deviceWorkspaces 的连接。形状照 `project/changed` */
export const THREAD_SECTIONS_CHANGED = 'litch/threadSection/changed'

export interface ThreadSectionsChangedNotification {
  sectionId: string
  changeType: 'created' | 'updated' | 'deleted'
}

/** 多了一个 `harness` 的对象：聚合面上的会话对象、不带会话标识的引擎通知、要指明发给谁的请求 */
export type WithHarness<T> = T & { harness: string }

/**
 * 合并的会话列表里，这一次没有列它的会话的 harness。凡是该问而没问到的都在：
 * 正在连或者断了的、适配器主进程说没在跑的（停用了、没装、没起来、正在起）、问了没成的。
 * 所以应答里没有某个 harness 的会话时，看这里就知道是它真的没有，还是这一次没问到它。
 */
export interface ThreadListSkippedHarness {
  harness: string
  /** unavailable：当时不可用，没有问；failed：问了，它回了错误或者中途断了 */
  reason: 'unavailable' | 'failed'
  /**
   * 为什么不可用，和 `runtime/info` 里 `HarnessInfo.unavailable.kind` 是同一套词、同一个值。
   * `reason` 是 unavailable 而且应答的这一刻它确实不可用时才有；failed 的没有，
   * 这一轮翻页开始时不可用、现在已经恢复的（那一轮的后几页仍然不含它）也没有。
   */
  kind?: HarnessUnavailableKind
  message: string
}

/**
 * 聚合面自己回的错误。`error.data.litch` 里是原因；上游引擎回的错误原样转发，没有这个字段。
 * 错误码尽量用标准的，这样只认标准错误码的客户端也能正确降级。
 */
export const DEVICE_ERROR_CODE = {
  /**
   * 聚合面不支持这个方法；或者请求要发给的那个原生 codex 不认识这个方法（这时 data 里带 `harness`：
   * 它对不认识的方法回的是“无效请求”，聚合面换成这一种，别的错误原样转发）。用标准的“方法不存在”
   */
  unsupported: -32601,
  /** 握手时没有声明聚合面要求的扩展 */
  extensionRequired: -32600,
  /** `harness` 参数填的不是这台设备上配置的 harness */
  unknownHarness: -32602,
  /** 哪个 harness 都不认识这个会话 */
  unknownThread: -32602,
  /** 请求要发给的 harness 现在不可用，或者等应答的时候它断开了 */
  harnessUnavailable: -32050,
} as const

export type DeviceErrorReason = keyof typeof DEVICE_ERROR_CODE

export interface DeviceErrorData {
  litch: DeviceErrorReason
  method?: string
  harness?: string
  threadId?: string
  /** extensionRequired：聚合面要求声明的扩展 */
  required?: string[]
  /** extensionRequired：这个设备服务支持的扩展 */
  supported?: string[]
  /** unknownThread：当时不可用、因而没问到的 harness */
  unavailable?: string[]
}
