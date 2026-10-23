// 客户端实际会调用的方法、会处理的通知，各自的参数和应答类型。
// 没列在这里的方法客户端不调用；没列在这里的通知客户端不处理（记日志后丢弃）。
// 新增一项要在这里登记，核心里才有类型可用。

import type { BackgroundChangedNotification } from './background-tasks.mjs'
import type { ClientToolCallParams, ClientToolCallResponse } from './client-tools.mjs'
import type {
  AccountRateLimitsUpdatedNotification,
  AgentMessageDeltaNotification,
  CollaborationModeListResponse,
  CommandExecutionOutputDeltaNotification,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigRequirementsReadResponse,
  ErrorNotification,
  FileChangePatchUpdatedNotification,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  FsChangedNotification,
  FsGetMetadataParams,
  FsGetMetadataResponse,
  FsReadDirectoryParams,
  FsReadDirectoryResponse,
  FsReadFileParams,
  FsReadFileResponse,
  FsUnwatchParams,
  FsWatchParams,
  FsWatchResponse,
  FuzzyFileSearchParams,
  FuzzyFileSearchResponse,
  GetAccountRateLimitsParams,
  GetAccountRateLimitsResponse,
  InitializeParams,
  InitializeResponse,
  ItemCompletedNotification,
  ItemStartedNotification,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  ModelListParams,
  ModelListResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  PlanDeltaNotification,
  ProcessExitedNotification,
  ProcessKillParams,
  ProcessOutputDeltaNotification,
  ProcessResizePtyParams,
  ProcessSpawnParams,
  ProcessWriteStdinParams,
  ProjectChangedNotification,
  ProjectCreateParams,
  ProjectCreateResponse,
  ProjectDeleteParams,
  ProjectListParams,
  ProjectListResponse,
  ProjectMoveParams,
  ProjectUpdateParams,
  ProjectUpdateResponse,
  ReasoningSummaryPartAddedNotification,
  ReasoningSummaryTextDeltaNotification,
  ReasoningTextDeltaNotification,
  ServerRequestResolvedNotification,
  SkillsListParams,
  SkillsListResponse,
  ThreadArchivedNotification,
  ThreadArchiveParams,
  ThreadBackgroundTerminalsCleanParams,
  ThreadBackgroundTerminalsCleanResponse,
  ThreadBackgroundTerminalsListParams,
  ThreadBackgroundTerminalsListResponse,
  ThreadBackgroundTerminalsTerminateParams,
  ThreadBackgroundTerminalsTerminateResponse,
  ThreadClosedNotification,
  ThreadCompactStartParams,
  ThreadCompactStartResponse,
  ThreadDeletedNotification,
  ThreadDeleteParams,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadGoalClearedNotification,
  ThreadGoalClearParams,
  ThreadGoalClearResponse,
  ThreadGoalGetParams,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadGoalUpdatedNotification,
  ThreadListParams,
  ThreadListResponse,
  ThreadMetadataUpdateParams,
  ThreadMetadataUpdateResponse,
  ThreadNameUpdatedNotification,
  ThreadProjectUpdatedNotification,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadRevertedNotification,
  ThreadRevertParams,
  ThreadRevertResponse,
  ThreadSectionCreateParams,
  ThreadSectionCreateResponse,
  ThreadSectionDeleteParams,
  ThreadSectionListParams,
  ThreadSectionListResponse,
  ThreadSectionMoveParams,
  ThreadSectionUpdateParams,
  ThreadSetNameParams,
  ThreadSettingsUpdatedNotification,
  ThreadStartedNotification,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadStatusChangedNotification,
  ThreadTokenUsageUpdatedNotification,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadUnarchivedNotification,
  ThreadUnarchiveParams,
  ThreadUnarchiveResponse,
  ThreadUnsubscribeParams,
  ThreadUnsubscribeResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification,
  TurnInterruptParams,
  TurnPlanUpdatedNotification,
  TurnStartedNotification,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from './codex.mjs'
import type {
  DeviceRuntimeInfo,
  HarnessStatusChangedNotification,
  ThreadListSkippedHarness,
  ThreadSectionsChangedNotification,
  ThreadSectionUpdatedNotification,
} from './device.mjs'
import type {
  HarnessInstallChangedNotification,
  HarnessInstallParams,
  HarnessInstallReadResponse,
  HarnessInstallResponse,
  HarnessVersionsParams,
  HarnessVersionsResponse,
} from './device-harness-install.mjs'
import type {
  DevicePairChangedNotification,
  DevicePairDecideParams,
  DevicePairEnrollParams,
  DevicePairEnrollResponse,
  DevicePairIdParams,
  DevicePairPhonesChangedNotification,
  DevicePairPhonesResponse,
  DevicePairRevokeParams,
  DevicePairStartParams,
  DevicePairStartResponse,
  DevicePairWaitParams,
  PairStatus,
} from './device-pairing.mjs'
import type {
  DeviceProcessAttachParams,
  DeviceProcessAttachResponse,
  DeviceProcessChangedNotification,
  DeviceProcessExitMark,
  DeviceProcessHandleParams,
  DeviceProcessKillParams,
  DeviceProcessListResponse,
  DeviceProcessOutputMark,
  DeviceProcessSpawnParams,
  DeviceProcessSpawnResponse,
} from './device-processes.mjs'
import type {
  DeviceDiagnosticsParams,
  DeviceDiagnosticsResponse,
  DeviceHarnessRestartParams,
  DeviceHarnessRestartResponse,
  DeviceLogsReadParams,
  DeviceLogsReadResponse,
  DeviceSettingsChangedNotification,
  DeviceSettingsReadResponse,
  DeviceSettingsWriteParams,
  DeviceSettingsWriteResponse,
  DeviceSshConfigResponse,
} from './device-settings.mjs'
import type {
  DeviceTaskChangedNotification,
  DeviceTaskCreateParams,
  DeviceTaskIdParams,
  DeviceTaskListResponse,
  DeviceTaskResponse,
  DeviceTaskRunChangedNotification,
  DeviceTaskRunNowResponse,
  DeviceTaskRunsListParams,
  DeviceTaskRunsListResponse,
  DeviceTaskRunsMarkReadParams,
  DeviceTaskUpdateParams,
} from './device-tasks.mjs'
import type { RuntimeInfoResponse } from './extensions.mjs'
import type {
  DeviceInstructionsSeparateParams,
  DeviceInstructionsSeparateResponse,
  DeviceInstructionsUnifyParams,
  DeviceInstructionsUnifyResponse,
  HarnessAuthAttemptParams,
  HarnessAuthContinueParams,
  HarnessAuthStartParams,
  HarnessAuthStartResponse,
  HarnessAuthStep,
  HarnessAuthUpdatedNotification,
  HarnessConfigActionParams,
  HarnessConfigChangedNotification,
  HarnessConfigReadResponse,
  HarnessConfigWriteParams,
  HarnessConfigWriteResponse,
  HarnessInstructionsInfo,
  HarnessInstructionsWriteParams,
  HarnessInstructionsWriteResponse,
  HarnessMcpNameParams,
  HarnessMcpReadResponse,
  HarnessMcpRemoveParams,
  HarnessMcpUpsertParams,
  HarnessMcpWriteResponse,
  HarnessModelsReadResponse,
  HarnessModelsWriteParams,
  HarnessModelsWriteResponse,
  HarnessParams,
  HarnessProviderIdParams,
  HarnessProvidersActivateParams,
  HarnessProvidersReadResponse,
  HarnessProvidersUpsertParams,
  HarnessProvidersWriteResponse,
} from './harness-config.mjs'
import type { NativeOwnerChangedNotification } from './native-owner.mjs'
import type {
  LineageUpdatedNotification,
  ProposalChangedNotification,
  SessionDetachParams,
  SessionProposalAnswerParams,
  SessionProposalHereParams,
  SessionProposalIdParams,
  SessionProposalListParams,
  SessionProposalListResponse,
  SessionProposalMarkHereResult,
  SessionStartParams,
  SessionStartResponse,
} from './session-tree.mjs'
import type {
  Worktree,
  WorktreeBranchesParams,
  WorktreeBranchesResponse,
  WorktreeChangedNotification,
  WorktreeListResponse,
  WorktreeRemoveParams,
  WorktreeStartFields,
} from './worktrees.mjs'

/**
 * 设备服务的聚合面上，不带会话标识的请求要多带一个 `harness` 指明发给谁（见 device.mts）。
 * 对面不是聚合面时不许带：有些参数结构遇到不认识的字段会直接拒绝。
 */
type ToHarness<T> = T & { harness?: string }
/**
 * 切在回合中间（我们的扩展，harness 声明了 `features.revert.byItemId` 才带）：`beforeTurnId` 那个回合里
 * 插进去的一条用户消息。保留之前的回合和这一回合在它之前的部分，它和它之后的都不要
 */
type CutBeforeItem<T> = T & { beforeItemId?: string }

/** 客户端发给对面的请求 */
export interface ClientRequests {
  initialize: { params: InitializeParams; result: InitializeResponse }
  /**
   * 聚合面上是各个 harness 合并后的列表：带 `harness` 时只列那一个；
   * 应答里多一个 `skippedHarnesses`，说这一次哪些 harness 的会话没有列出来（不可用的、停用的、没装的、问了没成的）
   */
  'thread/list': {
    params: ToHarness<ThreadListParams>
    result: ThreadListResponse & { skippedHarnesses?: ThreadListSkippedHarness[] }
  }
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse }
  /** 按页列一个会话的回合（默认新的在前）。子代理列表用它取每个子线程最近的一个回合，不带条目 */
  'thread/turns/list': { params: ThreadTurnsListParams; result: ThreadTurnsListResponse }
  /** 载入一个会话并订阅它的事件。之后这条连接会收到它的回合、条目通知和待答复的请求 */
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse }
  'thread/unsubscribe': { params: ThreadUnsubscribeParams; result: ThreadUnsubscribeResponse }
  'thread/start': {
    params: ToHarness<ThreadStartParams & WorktreeStartFields>
    result: ThreadStartResponse
  }
  'thread/name/set': { params: ThreadSetNameParams; result: Record<string, never> }
  // 持续目标（协议原有，harness 声明了 features.goals 才调）。set 是部分更新：省略的字段不变，
  // tokenBudget 给 null 是去掉预算；用户在界面上点的带 origin: 'user'
  'thread/goal/set': { params: ThreadGoalSetParams; result: ThreadGoalSetResponse }
  'thread/goal/get': { params: ThreadGoalGetParams; result: ThreadGoalGetResponse }
  'thread/goal/clear': { params: ThreadGoalClearParams; result: ThreadGoalClearResponse }
  'thread/archive': { params: ThreadArchiveParams; result: Record<string, never> }
  'thread/delete': { params: ThreadDeleteParams; result: Record<string, never> }
  'thread/unarchive': { params: ThreadUnarchiveParams; result: ThreadUnarchiveResponse }
  /** 从一个会话分出一个新会话，可以只带到某个回合为止的历史 */
  'thread/fork': { params: CutBeforeItem<ThreadForkParams>; result: ThreadForkResponse }
  /** 把某个回合和它之后的都从历史里撤掉。只改对话记录，不还原文件 */
  'thread/revert': { params: CutBeforeItem<ThreadRevertParams>; result: ThreadRevertResponse }
  // 后台终端（实验性接口，握手时要声明 experimentalApi）：会话里回合结束后还在跑的命令。
  // 客户端现在不调，收在这里留给以后的“停止”（backgroundTasks 扩展第一版不做停止）
  'thread/backgroundTerminals/list': {
    params: ThreadBackgroundTerminalsListParams
    result: ThreadBackgroundTerminalsListResponse
  }
  'thread/backgroundTerminals/terminate': {
    params: ThreadBackgroundTerminalsTerminateParams
    result: ThreadBackgroundTerminalsTerminateResponse
  }
  /** 停掉这个会话全部的后台终端 */
  'thread/backgroundTerminals/clean': {
    params: ThreadBackgroundTerminalsCleanParams
    result: ThreadBackgroundTerminalsCleanResponse
  }
  /** 手动压缩上下文。应答只表示受理了，压缩本身是随后的一个回合 */
  'thread/compact/start': { params: ThreadCompactStartParams; result: ThreadCompactStartResponse }
  'turn/start': { params: TurnStartParams; result: TurnStartResponse }
  'turn/interrupt': { params: TurnInterruptParams; result: Record<string, never> }
  /** 往正在进行的回合里插一句话 */
  'turn/steer': { params: TurnSteerParams; result: TurnSteerResponse }
  'model/list': { params: ToHarness<ModelListParams>; result: ModelListResponse }
  /**
   * 账号的用量额度（Codex 的 ChatGPT 登录、Claude Code 的订阅登录才有）：主额度的 5 小时、每周两个窗口，
   * 按模型分的等别的额度在 rateLimitsByLimitId 里。聚合面上要带 `harness`
   */
  'account/rateLimits/read': {
    params: ToHarness<GetAccountRateLimitsParams>
    result: GetAccountRateLimitsResponse
  }
  /**
   * 对面现在的配置（合上各层之后的）。客户端只用它算不带设置新建会话时对面会用什么（新建页的默认显示）。
   * cwd 给了就按那个目录看（项目里的配置层也算上）。聚合面上要带 `harness`
   */
  'config/read': { params: ToHarness<ConfigReadParams>; result: ConfigReadResponse }
  /** 管理方下发的约束（允许的权限档、新会话的默认权限档和模型）。没有约束时 requirements 是 null */
  'configRequirements/read': {
    params: ToHarness<object>
    result: ConfigRequirementsReadResponse
  }
  /**
   * 这几个工作目录下各看得到哪些技能。`cwds` 不给就是对面自己的当前目录。
   * 聚合面上这是“针对某个 harness”的请求，要带 `harness`
   */
  'skills/list': { params: ToHarness<SkillsListParams>; result: SkillsListResponse }
  /**
   * 这个 harness 有哪几种协作模式（实验性接口，握手时要声明 experimentalApi）。有 `mode: 'plan'` 的一项就是会计划模式。
   * 协议里它没有参数；聚合面上这是“针对某个 harness”的请求，要带 `harness`
   */
  'collaborationMode/list': {
    params: { harness?: string }
    result: CollaborationModeListResponse
  }
  'project/list': { params: ProjectListParams; result: ProjectListResponse }
  // 工作区的增删改、会话的归属与置顶。都是协议里现成的方法：单个入口上读写的是那个引擎自己的项目，
  // 聚合面上由设备层处理、数据跨 harness（扩展 deviceWorkspaces，见 device.mts）
  'project/create': { params: ProjectCreateParams; result: ProjectCreateResponse }
  /** `metadata` 给了就整份换掉，要保留的键得一起带上 */
  'project/update': { params: ProjectUpdateParams; result: ProjectUpdateResponse }
  /** 排到 `beforeProjectId` 前面；不给就排到最后 */
  'project/move': { params: ProjectMoveParams; result: Record<string, never> }
  /** 只删工作区这条记录：里面的会话解除归属，会话和文件都不动 */
  'project/delete': { params: ProjectDeleteParams; result: Record<string, never> }
  /** 改会话的归属：`projectId` 给空字符串是解除。聚合面上会话所属的 harness 不可用时做不了 */
  'thread/metadata/update': {
    params: ThreadMetadataUpdateParams
    result: ThreadMetadataUpdateResponse
  }
  /**
   * 把会话放进一个分区，或者（`sectionId` 给 null）拿出来。置顶就是放进固定标识的那个分区
   * （PINNED_SECTION_ID）。聚合面上会话所属的 harness 不可用时也能做
   */
  'thread/section/move': { params: ThreadSectionMoveParams; result: Record<string, never> }
  /** 分区：列出、新建、改名、删除。置顶那个分区排在列表最前面，不能改也不能删；删分区只是把里面的会话放出来 */
  'threadSection/list': { params: ThreadSectionListParams; result: ThreadSectionListResponse }
  'threadSection/create': { params: ThreadSectionCreateParams; result: ThreadSectionCreateResponse }
  'threadSection/update': { params: ThreadSectionUpdateParams; result: ThreadSectionCreateResponse }
  'threadSection/delete': { params: ThreadSectionDeleteParams; result: Record<string, never> }
  /**
   * 扩展。应答有两种形状：适配器的单个入口报它自己那个引擎（extensions.mts），
   * 设备服务的聚合面报设备和上面的各个 harness（device.mts）。原生 codex 不认识这个方法
   */
  'runtime/info': {
    params: Record<string, never>
    result: RuntimeInfoResponse | DeviceRuntimeInfo
  }
  // 以下是设备配置接口（扩展 deviceSettings，见 device-settings.mts）：只有聚合面有，
  // 而且设备信息的 `extensions` 里列了 deviceSettings 才能调用
  'litch/device/settings/read': {
    params: Record<string, never>
    result: DeviceSettingsReadResponse
  }
  /** 全有或全无。版本号对不上回 settingsConflict，错误里带最新的快照 */
  'litch/device/settings/write': {
    params: DeviceSettingsWriteParams
    result: DeviceSettingsWriteResponse
  }
  /** 等到那个 harness 有了结果才应答，最长约一分半钟：调用时要把超时放宽 */
  'litch/device/harness/restart': {
    params: DeviceHarnessRestartParams
    result: DeviceHarnessRestartResponse
  }
  'litch/device/diagnostics/run': {
    params: DeviceDiagnosticsParams
    result: DeviceDiagnosticsResponse
  }
  'litch/device/logs/read': { params: DeviceLogsReadParams; result: DeviceLogsReadResponse }
  'litch/device/sshConfig/read': {
    params: Record<string, never>
    result: DeviceSshConfigResponse
  }
  // 以下是终端用的进程。协议原有的四个哪种对面都有（原生 codex 上是实验性接口）；
  // `litchDevice` 这个参数和 litch/process/ 开头的几个是可重连终端的扩展（deviceProcesses，见 device-processes.mts）：
  // 只有聚合面有，而且设备信息的 `extensions` 里列了 deviceProcesses 才能用，没列的连这个参数都不许带
  /**
   * 起一个进程。终端要显式给 `timeoutMs: null`、`outputBytesCap: null`：不给的话 10 秒后被结束、每路输出到 1 MiB 就不再读。
   * 应答里有 `litchDevice` 才是属于设备的进程；没有就是属于这条连接的，连接一断就结束
   */
  'process/spawn': {
    params: ProcessSpawnParams & DeviceProcessSpawnParams
    result: DeviceProcessSpawnResponse
  }
  'process/writeStdin': { params: ProcessWriteStdinParams; result: Record<string, never> }
  'process/resizePty': { params: ProcessResizePtyParams; result: Record<string, never> }
  'process/kill': { params: ProcessKillParams; result: Record<string, never> }
  'litch/process/list': { params: Record<string, never>; result: DeviceProcessListResponse }
  /** 应答先到，留着的输出随后作为 process/outputDelta 发来 */
  'litch/process/attach': {
    params: DeviceProcessAttachParams
    result: DeviceProcessAttachResponse
  }
  'litch/process/detach': { params: DeviceProcessHandleParams; result: Record<string, never> }
  'litch/process/kill': { params: DeviceProcessKillParams; result: Record<string, never> }
  'litch/process/remove': { params: DeviceProcessHandleParams; result: Record<string, never> }
  // 以下是定时任务（扩展 deviceTasks，见 device-tasks.mts）：只有聚合面有，
  // 而且设备信息的 `extensions` 里列了 deviceTasks 才能用
  'litch/task/list': { params: Record<string, never>; result: DeviceTaskListResponse }
  'litch/task/create': { params: DeviceTaskCreateParams; result: DeviceTaskResponse }
  /** revision 对不上回 taskConflict，错误里带最新的任务 */
  'litch/task/update': { params: DeviceTaskUpdateParams; result: DeviceTaskResponse }
  'litch/task/delete': { params: DeviceTaskIdParams; result: Record<string, never> }
  'litch/task/runNow': { params: DeviceTaskIdParams; result: DeviceTaskRunNowResponse }
  'litch/task/runs/list': { params: DeviceTaskRunsListParams; result: DeviceTaskRunsListResponse }
  'litch/task/runs/markRead': {
    params: DeviceTaskRunsMarkReadParams
    result: Record<string, never>
  }
  // 以下是扫码绑定手机（扩展 devicePairing，见 device-pairing.mts）：只有聚合面有，
  // 设备信息的 `extensions` 里列了 devicePairing 才能用；不要求握手时声明（命令行直接连 device.sock 调）
  'litch/pair/start': { params: DevicePairStartParams; result: DevicePairStartResponse }
  'litch/pair/cancel': { params: DevicePairIdParams; result: Record<string, never> }
  'litch/pair/decide': { params: DevicePairDecideParams; result: PairStatus }
  'litch/pair/wait': { params: DevicePairWaitParams; result: PairStatus }
  'litch/pair/enroll': { params: DevicePairEnrollParams; result: DevicePairEnrollResponse }
  'litch/pair/phones': { params: Record<string, never>; result: DevicePairPhonesResponse }
  'litch/pair/revoke': { params: DevicePairRevokeParams; result: Record<string, never> }
  // 以下是给设备装 harness（扩展 harnessInstall，见 device-harness-install.mts）：只有聚合面有，
  // 设备信息的 `extensions` 里列了 harnessInstall 才能用
  'litch/device/harness/versions': {
    params: HarnessVersionsParams
    result: HarnessVersionsResponse
  }
  'litch/device/harness/install': { params: HarnessInstallParams; result: HarnessInstallResponse }
  'litch/device/harness/install/read': {
    params: Record<string, never>
    result: HarnessInstallReadResponse
  }
  // 以下是 harness 详情设置（扩展 harnessConfig，见 harness-config.mts）：都带 harness 参数，转给那个引擎；
  // 原生 codex 由设备进程翻译。litch/device/instructions/* 由设备进程自己处理
  'litch/harness/config/read': { params: HarnessParams; result: HarnessConfigReadResponse }
  'litch/harness/config/write': {
    params: HarnessConfigWriteParams
    result: HarnessConfigWriteResponse
  }
  'litch/harness/config/action': {
    params: HarnessConfigActionParams
    result: Record<string, never>
  }
  'litch/harness/providers/read': { params: HarnessParams; result: HarnessProvidersReadResponse }
  'litch/harness/providers/upsert': {
    params: HarnessProvidersUpsertParams
    result: HarnessProvidersWriteResponse
  }
  'litch/harness/providers/remove': {
    params: HarnessProviderIdParams
    result: HarnessProvidersWriteResponse
  }
  'litch/harness/providers/activate': {
    params: HarnessProvidersActivateParams
    result: HarnessProvidersWriteResponse
  }
  'litch/harness/auth/start': { params: HarnessAuthStartParams; result: HarnessAuthStartResponse }
  'litch/harness/auth/continue': { params: HarnessAuthContinueParams; result: HarnessAuthStep }
  'litch/harness/auth/cancel': { params: HarnessAuthAttemptParams; result: Record<string, never> }
  'litch/harness/auth/logout': { params: HarnessProviderIdParams; result: Record<string, never> }
  'litch/harness/mcp/read': { params: HarnessParams; result: HarnessMcpReadResponse }
  'litch/harness/mcp/upsert': { params: HarnessMcpUpsertParams; result: HarnessMcpWriteResponse }
  'litch/harness/mcp/remove': { params: HarnessMcpRemoveParams; result: HarnessMcpWriteResponse }
  'litch/harness/mcp/login': { params: HarnessMcpNameParams; result: HarnessAuthStartResponse }
  'litch/harness/instructions/read': { params: HarnessParams; result: HarnessInstructionsInfo }
  'litch/harness/instructions/write': {
    params: HarnessInstructionsWriteParams
    result: HarnessInstructionsWriteResponse
  }
  'litch/harness/models/read': { params: HarnessParams; result: HarnessModelsReadResponse }
  'litch/harness/models/write': {
    params: HarnessModelsWriteParams
    result: HarnessModelsWriteResponse
  }
  'litch/device/instructions/unify': {
    params: DeviceInstructionsUnifyParams
    result: DeviceInstructionsUnifyResponse
  }
  'litch/device/instructions/separate': {
    params: DeviceInstructionsSeparateParams
    result: DeviceInstructionsSeparateResponse
  }
  // 以下是会话树（扩展 sessionTree，见 session-tree.mts）：只有聚合面有，
  // 而且设备信息的 `extensions` 里列了 sessionTree 才能用
  'litch/session/start': { params: SessionStartParams; result: SessionStartResponse }
  'litch/session/detach': { params: SessionDetachParams; result: Record<string, never> }
  'litch/sessionProposal/list': {
    params: SessionProposalListParams
    result: SessionProposalListResponse
  }
  'litch/sessionProposal/accept': { params: SessionProposalIdParams; result: SessionStartResponse }
  'litch/sessionProposal/dismiss': {
    params: SessionProposalIdParams
    result: Record<string, never>
  }
  'litch/sessionProposal/answer': {
    params: SessionProposalAnswerParams
    result: Record<string, never>
  }
  'litch/sessionProposal/here': {
    params: SessionProposalHereParams
    result: Record<string, never>
  }
  'litch/sessionProposal/markHere': {
    params: SessionProposalHereParams
    result: SessionProposalMarkHereResult
  }
  // 以下是工作树（扩展 worktrees，见 worktrees.mts）：只有聚合面有，设备信息的 `extensions` 里列了 worktrees 才能用
  'litch/worktree/list': { params: Record<string, never>; result: WorktreeListResponse }
  'litch/worktree/branches': { params: WorktreeBranchesParams; result: WorktreeBranchesResponse }
  'litch/worktree/remove': { params: WorktreeRemoveParams; result: { worktree: Worktree } }
  'litch/worktree/restore': { params: { id: string }; result: { worktree: Worktree } }
  // 以下是文件面板用的：列目录、读文件、取元数据、模糊找文件。都是协议里现成的方法，哪种对面都有。
  // 聚合面上它们由设备进程自己处理（packages/device/src/routes.mts），不转给任何引擎，所以不带 `harness`，
  // 哪个 harness 掉线都不影响；单个 harness 的入口上是那个引擎进程在读；原生 codex 是它自己读。
  // 路径一律是对面机器上的绝对路径。协议不限制能读哪里：限制在工作区的根之内是客户端自己守的（core 的 device/files.mts）
  /** 只列这一层。条目只有名字和“是不是目录、是不是普通文件”，没有大小；符号链接在适配器上两样都不是 */
  'fs/readDirectory': { params: FsReadDirectoryParams; result: FsReadDirectoryResponse }
  /** 整个文件一次读回来（base64）。协议没有“只读一段”，元数据里也没有大小，读之前不知道它多大 */
  'fs/readFile': { params: FsReadFileParams; result: FsReadFileResponse }
  /** 跟着符号链接走到底之后是什么；`isSymlink` 说的是这个路径本身 */
  'fs/getMetadata': { params: FsGetMetadataParams; result: FsGetMetadataResponse }
  // 以下四个是 litch_machine 的执行器写文件、建目录用的（core 的 device/machine/）。
  // 形状照上游 codex 0.157.1 的 v2/Fs*Params（都只回空对象）；适配器的实现在 packages/shared/src/filesystem-rpc.mts
  /** 整个写进去（已有的覆盖），父目录要已经在了。协议里没有“接在后面写” */
  'fs/writeFile': { params: { path: string; dataBase64: string }; result: Record<string, never> }
  /** recursive 缺省为真（连父目录一起建，已有的不算错） */
  'fs/createDirectory': {
    params: { path: string; recursive?: boolean | null }
    result: Record<string, never>
  }
  /** recursive、force 缺省都为真 */
  'fs/remove': {
    params: { path: string; recursive?: boolean | null; force?: boolean | null }
    result: Record<string, never>
  }
  /** 复制目录要 recursive 为真 */
  'fs/copy': {
    params: { sourcePath: string; destinationPath: string; recursive?: boolean }
    result: Record<string, never>
  }
  /**
   * 一次性的模糊找文件：最多回 50 条，`path` 相对于 `root`。同一个 `cancellationToken` 的新请求会让还没完的旧请求作废
   * （适配器上旧请求回空结果，所以“没找到”和“被顶掉了”要靠客户端自己记是哪一次）。
   * 带会话的那三个（fuzzyFileSearch/session*）在原生 codex 上是实验性接口，这里不用
   */
  fuzzyFileSearch: { params: FuzzyFileSearchParams; result: FuzzyFileSearchResponse }
  // 以下是差异面板用的：监视一个路径有没有变。也是协议里现成的方法，哪种对面都有。
  /**
   * 监视一个文件或目录，只看这一层（不往下一层层看），变了发 `fs/changed`。`watchId` 由客户端起，
   * 一条连接里不能重复；监视随连接结束。差异面板拿它盯 git 的元数据目录和工作区的根
   */
  'fs/watch': { params: FsWatchParams; result: FsWatchResponse }
  'fs/unwatch': { params: FsUnwatchParams; result: Record<string, never> }
}

export type ClientRequestMethod = keyof ClientRequests

/** 客户端发给对面的通知 */
export interface ClientNotifications {
  initialized: undefined
}

/** 对面发来、客户端会处理的通知 */
export interface ServerNotifications {
  'thread/started': ThreadStartedNotification
  'thread/status/changed': ThreadStatusChangedNotification
  'thread/name/updated': ThreadNameUpdatedNotification
  'thread/archived': ThreadArchivedNotification
  'thread/unarchived': ThreadUnarchivedNotification
  'thread/deleted': ThreadDeletedNotification
  /** 对面把没人订阅、闲着的会话卸载了。之前已经发过 thread/status/changed（notLoaded） */
  'thread/closed': ThreadClosedNotification
  'thread/project/updated': ThreadProjectUpdatedNotification
  'project/changed': ProjectChangedNotification
  /** 扩展，只发给握手时声明过 deviceWorkspaces 的连接：一个会话进了、出了、换了分区（置顶也是它） */
  'litch/thread/section/updated': ThreadSectionUpdatedNotification
  /** 扩展，只发给握手时声明过 deviceWorkspaces 的连接：分区本身建了、改了、删了 */
  'litch/threadSection/changed': ThreadSectionsChangedNotification
  /** 扩展，只有聚合面会发：某个 harness 的可用状态、原因或者名字版本变了 */
  'litch/harness/status/changed': HarnessStatusChangedNotification
  /** 扩展，只发给握手时声明过 deviceSettings 的连接：设置、待重启的名单或者 SSH 入口的状况变了 */
  'litch/device/settings/changed': DeviceSettingsChangedNotification
  /** 进程的一块输出。属于设备的进程发来的每一块都带着 `litchDevice`：这一块从哪个偏移开始、之前少了多少 */
  'process/outputDelta': ProcessOutputDeltaNotification & { litchDevice?: DeviceProcessOutputMark }
  'process/exited': ProcessExitedNotification & { litchDevice?: DeviceProcessExitMark }
  /** `fs/watch` 盯着的路径变了。只说哪些路径，不说怎么变的 */
  'fs/changed': FsChangedNotification
  /** 扩展，只发给握手时声明过 deviceProcesses 的连接：设备上属于设备的进程多了、少了、变了 */
  'litch/process/changed': DeviceProcessChangedNotification
  /** 扩展，只发给握手时声明过 sessionTree 的连接：一个会话的父子关系建立或脱离了 */
  'litch/thread/lineage/updated': LineageUpdatedNotification
  /** 扩展，只发给握手时声明过 sessionTree 的连接：一个会话上的提案变了 */
  'litch/sessionProposal/changed': ProposalChangedNotification
  /** 扩展，只发给握手时声明过 worktrees 的连接：设备层的一个工作树建成、换了主人、删了或恢复了 */
  'litch/worktree/changed': WorktreeChangedNotification
  /** 扩展，只发给握手时声明过 devicePairing 的连接：一个配对的状态变了 */
  'litch/pair/changed': DevicePairChangedNotification
  /** 扩展，只发给握手时声明过 devicePairing 的连接：已绑定的手机多了、少了 */
  'litch/pair/phones/changed': DevicePairPhonesChangedNotification
  /** 扩展，只发给握手时声明过 harnessInstall 的连接：一个安装任务的状态或日志变了 */
  'litch/device/harness/install/changed': HarnessInstallChangedNotification
  'litch/harness/config/changed': HarnessConfigChangedNotification
  'litch/harness/auth/updated': HarnessAuthUpdatedNotification
  /**
   * 扩展，只发给握手时声明过 backgroundTasks 的连接（不只是订阅者）：一个会话的后台任务集合变了，整份重发
   */
  'litch/thread/background/changed': BackgroundChangedNotification
  /** 扩展，只发给握手时声明过 nativeOwner 的连接：一个导进来的会话被别处占上、放开了，或者对方开始、停下跑了 */
  'litch/thread/nativeOwner/changed': NativeOwnerChangedNotification
  /** 扩展，只发给握手时声明过 deviceTasks 的连接：任务多了、变了、没了 */
  'litch/task/changed': DeviceTaskChangedNotification
  /** 扩展，只发给握手时声明过 deviceTasks 的连接：一次运行开始了、结束了、标成看过了 */
  'litch/task/run/changed': DeviceTaskRunChangedNotification
  /** 一个会话的持续目标设了、改了（状态、用量）。上游发给每条握手过的连接，不只是订阅者 */
  'thread/goal/updated': ThreadGoalUpdatedNotification
  /** 一个会话的持续目标清掉了。同上，发给每条握手过的连接 */
  'thread/goal/cleared': ThreadGoalClearedNotification
  // 以下只有订阅了会话（thread/resume、thread/start）的连接才收得到
  'turn/started': TurnStartedNotification
  'turn/completed': TurnCompletedNotification
  'item/started': ItemStartedNotification
  'item/completed': ItemCompletedNotification
  'item/agentMessage/delta': AgentMessageDeltaNotification
  'item/reasoning/summaryTextDelta': ReasoningSummaryTextDeltaNotification
  'item/reasoning/summaryPartAdded': ReasoningSummaryPartAddedNotification
  'item/reasoning/textDelta': ReasoningTextDeltaNotification
  'item/commandExecution/outputDelta': CommandExecutionOutputDeltaNotification
  'item/fileChange/patchUpdated': FileChangePatchUpdatedNotification
  'item/plan/delta': PlanDeltaNotification
  /** 模型在回合里维护的待办清单：每次都是整份，不是增量 */
  'turn/plan/updated': TurnPlanUpdatedNotification
  /** 这个回合到现在为止改了什么：每次都是整份统一格式的差异。不是每个 harness 都发（能力位 turnDiff） */
  'turn/diff/updated': TurnDiffUpdatedNotification
  /** 会话的历史被改写了（回退）。不说撤掉了哪些，要知道得重新取 */
  'thread/reverted': ThreadRevertedNotification
  /** 会话的设置变了：别的客户端改的，或者引擎自己改的（模型退出了计划模式） */
  'thread/settings/updated': ThreadSettingsUpdatedNotification
  /** 这个会话的上下文现在用了多少。回合里每次模型请求之后来一条，载入会话时也会补一条 */
  'thread/tokenUsage/updated': ThreadTokenUsageUpdatedNotification
  /**
   * 账号额度变了，只带变了的那一份额度（按 limitId），要并进最近读到的那一份。
   * 不带会话标识：聚合面转发时加上 `harness` 说是哪个 harness 的
   */
  'account/rateLimits/updated': AccountRateLimitsUpdatedNotification & { harness?: string }
  error: ErrorNotification
  /** 一个待答复的请求有了结果：自己答的、别的客户端答的、或者回合结束作废了 */
  'serverRequest/resolved': ServerRequestResolvedNotification
}

export type ServerNotificationMethod = keyof ServerNotifications

/**
 * 对面发来、要客户端答复的请求。没列在这里的一律回“方法不存在”，对面的回合不会因此挂住。
 */
export interface ServerRequests {
  'item/commandExecution/requestApproval': {
    params: CommandExecutionRequestApprovalParams
    result: CommandExecutionRequestApprovalResponse
  }
  'item/fileChange/requestApproval': {
    params: FileChangeRequestApprovalParams
    result: FileChangeRequestApprovalResponse
  }
  'item/permissions/requestApproval': {
    params: PermissionsRequestApprovalParams
    result: PermissionsRequestApprovalResponse
  }
  'item/tool/requestUserInput': {
    params: ToolRequestUserInputParams
    result: ToolRequestUserInputResponse
  }
  'mcpServer/elicitation/request': {
    params: McpServerElicitationRequestParams
    result: McpServerElicitationRequestResponse
  }
  /**
   * 在客户端上执行一次动态工具调用。核心只认 litch_ 开头的命名空间（客户端工具扩展，client-tools.mts），
   * 别的照旧回“方法不存在”
   */
  'item/tool/call': {
    params: ClientToolCallParams
    result: ClientToolCallResponse
  }
}

export type ServerRequestMethod = keyof ServerRequests

/** JSON-RPC 的标准错误码里客户端要区分的几个 */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const

/**
 * 对面是不是在说“我不认识这个方法”。
 * 适配器回的是“方法不存在”；原生 codex 对不认识的方法回的是“无效请求”（前置验证 P8）。
 * 两种都要认，否则“失败就记住并降级”在原生 codex 上不成立。
 */
export function isUnknownMethodError(code: number): boolean {
  return code === RPC_ERROR.methodNotFound || code === RPC_ERROR.invalidRequest
}
