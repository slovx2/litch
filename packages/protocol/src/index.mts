// 协议包的入口。设备进程（packages/device）和客户端核心（packages/core）都从这里取类型。
// codex.mts 是 Codex 原有的，extensions.mts 是我们加的，两边分开放
// （设计文档 01 第五节规则 4、03 第十五节）。

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
export type * from './codex.mjs'
export { CODEX_PROTOCOL_VERSION } from './codex.mjs'
// 设备服务（聚合面）的扩展：device.mts 只取 harness-capabilities.mts 的类型，device-codex.mts 是它和 codex 类型拼出来的形状
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
export type * from './extensions.mjs'
// 每个 harness 的结构化声明（能力位、权限预设）和“拒绝时附说明”：harness-capabilities.mts 不依赖别的文件
export type * from './harness-capabilities.mjs'
export { DECLINE_NOTE_MAX_LENGTH, DECLINE_WITH_NOTE_DECISION } from './harness-capabilities.mjs'
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
