// 客户端工具（扩展名 clientTools）：模型调用的工具由连着的 Litch 桌面端执行，比如内置浏览器、Computer Use。
// 走的是 codex 协议原有的动态工具：建会话时 `thread/start.dynamicTools` 带上工具清单，模型调用时
// 引擎向客户端发 `item/tool/call`，客户端执行后答复。这里只有协议里没有的那部分：谁能执行、交给谁、
// 没人能执行时怎么回。定义的原文在仓库根目录 protocol/extensions/client-tools.json，
// 设计见 design/harness-client/05-browser-and-computer-use.md。
//
// 这个文件不引用别的文件：设备进程（packages/device）、引擎入口（packages/claude、packages/pi）、
// 客户端核心（packages/core）和桌面外壳都直接引用它。

/** 握手时 `capabilities` 里声明“我能执行哪些命名空间”的键（和 litchExtensions 并列） */
export const CLIENT_TOOLS_CAPABILITY = 'litchClientTools'

/** 客户端工具的命名空间一律以它开头。只有这种命名空间的调用按本扩展的规矩挑执行方，别的照上游 */
export const CLIENT_TOOL_NAMESPACE_PREFIX = 'litch_'

/** 现有的两个命名空间。上游保留了 browser、computer，所以带前缀 */
export const CLIENT_TOOL_NAMESPACE = {
  browser: 'litch_browser',
  computer: 'litch_computer',
  /** 只在测试里用：原样回参数，用来打通链路 */
  echo: 'litch_echo',
} as const

/** 握手时 `capabilities.litchClientTools` 的形状。没声明 clientTools 扩展时这一项不看 */
export interface ClientToolsDeclaration {
  /** 这条连接能执行的命名空间。每个都必须以 CLIENT_TOOL_NAMESPACE_PREFIX 开头 */
  namespaces: string[]
}

/** 握手参数里我们这个扩展加的部分 */
export interface ClientToolsCapabilities {
  litchClientTools?: ClientToolsDeclaration
}

/** 是不是客户端工具的命名空间 */
export function isClientToolNamespace(namespace: string | null | undefined): boolean {
  return typeof namespace === 'string' && namespace.startsWith(CLIENT_TOOL_NAMESPACE_PREFIX)
}

/** 从握手参数的 capabilities 里取出这条连接能执行的命名空间；没声明、形状不对都当作空 */
export function declaredClientToolNamespaces(
  capabilities: unknown,
  extensionDeclared: boolean,
): string[] {
  if (!extensionDeclared || !capabilities || typeof capabilities !== 'object') return []
  const raw = (capabilities as Record<string, unknown>)[CLIENT_TOOLS_CAPABILITY]
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as Record<string, unknown>).namespaces
  if (!Array.isArray(list)) return []
  return list.filter((one): one is string => isClientToolNamespace(one as string))
}

// —— 协议原有的形状（codex 0.157.1 起一致），这里抄一份最小的，免得设备进程去引 codex.mts ——

/** `item/tool/call` 的参数 */
export interface ClientToolCallParams {
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: unknown
}

/** 结果里的一项。图片只能是内联的 data: 地址，http(s) 地址会让整个结果作废 */
export type ClientToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }

/** `item/tool/call` 的答复 */
export interface ClientToolCallResponse {
  contentItems: ClientToolContentItem[]
  success: boolean
}

/** 动态工具的定义（`thread/start.dynamicTools` 的一项）。我们只用命名空间这种 */
export interface ClientToolFunctionSpec {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ClientToolNamespaceSpec {
  type: 'namespace'
  name: string
  description: string
  tools: ClientToolFunctionSpec[]
}

/** 失败答复的原因分类，放在文字的开头一行里给人和模型看，也方便测试认 */
export type ClientToolFailureKind =
  /** 这个会话没有连着能执行这个命名空间的 Litch 桌面端 */
  | 'noExecutor'
  /** 桌面端这台设备的设置里关着这项能力 */
  | 'disabled'
  /** 系统权限没给（Computer Use 的辅助功能、屏幕录制） */
  | 'permission'
  /** 用户在审批里拒绝了 */
  | 'declined'
  /** 不认识的工具、参数不对 */
  | 'invalid'
  /** 执行出错、超时、被打断 */
  | 'failed'

/** 拼一个失败答复。文字第一行是 `[litch:<kind>]`，后面是给模型看的说明（说明要告诉模型该怎么办） */
export function clientToolFailure(
  kind: ClientToolFailureKind,
  message: string,
): ClientToolCallResponse {
  return {
    success: false,
    contentItems: [{ type: 'inputText', text: `[litch:${kind}] ${message}` }],
  }
}
