export type * from './session-pending.mjs'
export type * from './turn-recovery.mjs'
export {
  RECOVERY_CHANGED,
  RECOVERY_CONTINUE,
  RECOVERY_DISMISS,
  RECOVERY_READ,
} from './turn-recovery.mjs'
// 协议包的入口。设备进程（packages/device）和客户端核心（packages/core）都从这里取类型。
// codex.mts 是 Codex 原有的，extensions.mts 是我们加的，两边分开放，
// 改上游的类型时不会碰到我们的扩展。

// 模型请求在重试（apiRetry 扩展）：回合状态行上的“重试中”。不依赖别的文件
export type * from './api-retry.mjs'
export { API_RETRY_NOTIFICATION } from './api-retry.mjs'
// 后台任务（backgroundTasks 扩展）：会话上回合结束后还在跑的工作、回合是谁开的。不依赖别的文件
export type * from './background-tasks.mjs'
export {
  BACKGROUND_ENDED_LIMIT,
  BACKGROUND_TASKS_NOTIFICATION,
  orderBackgroundTasks,
  runningBackgroundTasks,
} from './background-tasks.mjs'
// 手机上批准（clientApprovals 扩展）：卡片、答复、签名内容、形状检查。不依赖别的文件
export type * from './client-approvals.mjs'
export {
  APPROVAL_ACCOUNTS_MAX,
  APPROVAL_ANSWER,
  APPROVAL_ANSWERED,
  APPROVAL_ANSWERS_MAX,
  APPROVAL_CHANGED,
  APPROVAL_CLOSE,
  APPROVAL_ERROR,
  APPROVAL_LIST,
  APPROVAL_MAX_PER_CONNECTION,
  APPROVAL_OPEN,
  APPROVAL_PREFIX,
  APPROVAL_SIGN_PREFIX,
  APPROVAL_TEXT_MAX,
  approvalSignedText,
  isApprovalAnswer,
  isApprovalKey,
  isApprovalRef,
  isApprovalToken,
} from './client-approvals.mjs'
// 远程设备的会话里提到这台桌面端上的文件、文件夹：正文末尾那一段的写法与认回来。不依赖别的文件
export type * from './client-paths.mjs'
export {
  CLIENT_PATH_TAG,
  clientPathsBlock,
  folderPath,
  parseClientPaths,
} from './client-paths.mjs'
// 客户端工具（clientTools 扩展）：谁能执行 litch_ 开头的动态工具、没人能执行时怎么回。不依赖别的文件
export type * from './client-tools.mjs'
export {
  CLIENT_TOOL_NAMESPACE,
  CLIENT_TOOL_NAMESPACE_PREFIX,
  CLIENT_TOOLS_CAPABILITY,
  clientToolFailure,
  declaredClientToolNamespaces,
  isClientToolNamespace,
} from './client-tools.mjs'
// 配置 Litch（litch_config）：命令行经 invoke 交给桌面端核心的参数形状。不依赖别的文件
export type * from './client-tools-config.mjs'
export { CONFIG_NAMESPACE, CONFIG_TOOL } from './client-tools-config.mjs'
export type * from './client-tools-sessions.mjs'
export { SESSION_TOOL, SESSION_TOOL_LIMITS, SESSION_TOOLS } from './client-tools-sessions.mjs'
// litch_tasks 工具（模型建定时任务），执行方是设备服务
export type * from './client-tools-tasks.mjs'
export { TASKS_TOOLS } from './client-tools-tasks.mjs'
export type * from './codex.mjs'
export { CODEX_PROTOCOL_VERSION } from './codex.mjs'
// 设备服务（聚合面）的扩展：device.mts 只取 harness-capabilities.mts 的类型，device-codex.mts 是它和 codex 类型拼出来的形状
// `litch config` 的操作清单（执行器和产品手册都对着它）。不依赖别的文件
export type * from './config-ops.mjs'
export { CONFIG_OPS, configOpName } from './config-ops.mjs'
export type * from './device.mjs'
export {
  DEVICE_ERROR_CODE,
  EXTENSION,
  EXTENSIONS_CAPABILITY,
  HARNESS_STATUS_CHANGED,
  PINNED_SECTION_ID,
  THREAD_SECTION_UPDATED,
  THREAD_SECTIONS_CHANGED,
} from './device.mjs'
export type * from './device-codex.mjs'
// 给设备装 harness（harnessInstall 扩展）：版本、安装任务、方法和通知。不依赖别的文件
export type * from './device-harness-install.mjs'
export { HARNESS_INSTALL_METHOD, HARNESS_INSTALL_NOTIFICATION } from './device-harness-install.mjs'
// 扫码绑定手机（devicePairing 扩展）：二维码内容的编解码、手机与 pair-enroll 之间的一行、方法和通知。不依赖别的文件
export type * from './device-pairing.mjs'
export {
  base64UrlDecode,
  DEVICE_PAIR_CANCEL,
  DEVICE_PAIR_CHANGED,
  DEVICE_PAIR_DECIDE,
  DEVICE_PAIR_ENROLL,
  DEVICE_PAIR_ERROR,
  DEVICE_PAIR_PHONES,
  DEVICE_PAIR_PHONES_CHANGED,
  DEVICE_PAIR_REVOKE,
  DEVICE_PAIR_START,
  DEVICE_PAIR_WAIT,
  decodePairPayload,
  encodePairPayload,
  PAIR_DECIDE_TIMEOUT_MS,
  PAIR_ENROLL_ERROR,
  PAIR_KEY_MARK,
  PAIR_PAYLOAD_PREFIX,
  PAIR_PHONE_NAME_MAX,
  PAIR_TTL_MS,
  PHONE_KEY_MARK,
} from './device-pairing.mjs'
export type * from './device-power.mjs'
export { DEVICE_POWER_CHANGED, DEVICE_POWER_READ } from './device-power.mjs'
// 可重连的终端（deviceProcesses 扩展）：属于设备的进程的列出、挂接、解除、结束、清除。不依赖别的文件
export type * from './device-processes.mjs'
export {
  DEVICE_PROCESS_ATTACH,
  DEVICE_PROCESS_CHANGED,
  DEVICE_PROCESS_DETACH,
  DEVICE_PROCESS_ERROR_CODE,
  DEVICE_PROCESS_FIELD,
  DEVICE_PROCESS_KILL,
  DEVICE_PROCESS_LIST,
  DEVICE_PROCESS_REMOVE,
  DEVICE_PROCESS_TAG_MAX_BYTES,
} from './device-processes.mjs'
// 常驻服务报自己是哪一份（deviceService 扩展）：runtime/info 的 device.service。不依赖别的文件
export type * from './device-service.mjs'
// 设备配置接口（deviceSettings 扩展）：设置的结构和读写、重启 harness、诊断、日志、ssh 配置片段。不依赖别的文件
export type * from './device-settings.mjs'
export {
  DEVICE_DIAGNOSTICS_RUN,
  DEVICE_HARNESS_RESTART,
  DEVICE_LOGS_READ,
  DEVICE_SETTINGS_CHANGED,
  DEVICE_SETTINGS_ERROR_CODE,
  DEVICE_SETTINGS_READ,
  DEVICE_SETTINGS_WRITE,
  DEVICE_SSH_CONFIG_READ,
} from './device-settings.mjs'
// 定时任务（deviceTasks 扩展）：任务、运行记录、方法和通知的名字。不依赖别的文件
export type * from './device-tasks.mjs'
export {
  DEVICE_TASK_CHANGED,
  DEVICE_TASK_CREATE,
  DEVICE_TASK_DELETE,
  DEVICE_TASK_ERROR_CODE,
  DEVICE_TASK_LIST,
  DEVICE_TASK_RUN_CHANGED,
  DEVICE_TASK_RUN_NOW,
  DEVICE_TASK_RUNS_LIST,
  DEVICE_TASK_RUNS_MARK_READ,
  DEVICE_TASK_UPDATE,
  TASK_LIMIT,
  TASK_NAME_MAX,
  TASK_PROMPT_MAX,
  TASK_RUN_ERROR,
  TASK_RUN_SUMMARY_MAX,
} from './device-tasks.mjs'
export type * from './extensions.mjs'
// 每个 harness 的结构化声明（能力位、权限预设）和“拒绝时附说明”：harness-capabilities.mts 不依赖别的文件
export type * from './harness-capabilities.mjs'
export { DECLINE_NOTE_MAX_LENGTH, DECLINE_WITH_NOTE_DECISION } from './harness-capabilities.mjs'
// harness 详情设置（harnessConfig 扩展）：配置项、账号与 provider、MCP、指令文件。不依赖别的文件
export type * from './harness-config.mjs'
export {
  HARNESS_CONFIG_ERROR_CODE,
  HARNESS_CONFIG_METHOD,
  HARNESS_CONFIG_NOTIFICATION,
} from './harness-config.mjs'
export type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './jsonrpc.mjs'
export { isNotification, isRequest, isResponse } from './jsonrpc.mjs'
export type {
  ClientNotifications,
  ClientRequestMethod,
  ClientRequests,
  ServerNotificationMethod,
  ServerNotifications,
  ServerRequestMethod,
  ServerRequests,
} from './methods.mjs'
export { isUnknownMethodError, RPC_ERROR } from './methods.mjs'
// 别处占着的原生会话（nativeOwner 扩展）：被另一个进程开着时只读。不依赖别的文件
export type * from './native-owner.mjs'
export { NATIVE_OWNER_NOTIFICATION } from './native-owner.mjs'
// 别的会话发来的消息（peerMessages 扩展）：用户消息条目上的发送方。不依赖别的文件
export type * from './peer-messages.mjs'
// 输入框里 @ 的会话：正文末尾那一段的写法与认回来。引用 session-tree.mts
export type * from './session-mentions.mjs'
export {
  excerptOfTurns,
  matchMentions,
  mentionSegments,
  mentionSpots,
  mentionTitle,
  parseSessionMentions,
  SENT_SIGIL,
  SESSION_MENTION_LIMITS,
  SESSION_MENTION_TAG,
  sentText,
  sessionMentionsBlock,
} from './session-mentions.mjs'
// 会话树（sessionTree 扩展）：子会话的父子关系、提案、回报与唤醒；模型用的 litch_sessions 工具。不依赖别的文件
export type * from './session-tree.mjs'
export {
  formatSessionEvent,
  parseSessionEvent,
  SESSION_EVENT_TAG,
  SESSION_TREE_LIMITS,
  SESSION_TREE_METHOD,
  SESSION_TREE_NOTIFICATION,
} from './session-tree.mjs'
// Litch 替用户发进会话的话（定时任务、子会话的简报、在这里做、litch_sessions.send）：从用户消息里认回来。不依赖别的文件
export type * from './system-messages.mjs'
export { HERE_LEADS, parseSessionMessage, parseSystemMessage } from './system-messages.mjs'
// 定时任务的日程：校验、下一次、错过了几次。只用标准库
export type * from './task-schedule.mjs'
export {
  countTaskRuns,
  isTaskTimeZone,
  localTaskTimeZone,
  MIN_TASK_INTERVAL_MINUTES,
  nextTaskRun,
  validateTaskSchedule,
} from './task-schedule.mjs'
// 工作树（worktrees 扩展）：thread/start 上要一个新工作树、会话对象上的 litchWorktree、列出删除恢复
export type * from './worktrees.mjs'
export {
  WORKTREE_CHANGED,
  WORKTREE_DEFAULTS,
  WORKTREE_METHOD,
  WORKTREE_SETTING,
  WORKTREE_SNAPSHOT_REF,
} from './worktrees.mjs'
