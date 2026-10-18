// 客户端工具（扩展名 clientTools）：模型调用的工具由连着的 Litch 桌面端执行，比如内置浏览器、Computer Use。
// 走的是 codex 协议原有的动态工具：建会话时 `thread/start.dynamicTools` 带上工具清单，模型调用时
// 引擎向客户端发 `item/tool/call`，客户端执行后答复。这里只有协议里没有的那部分：谁能执行、交给谁、
// 没人能执行时怎么回。定义的原文在仓库根目录 protocol/extensions/client-tools.json。
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
  /** 操作机器上的命令和文件（第一期只有桌面端这台） */
  machine: 'litch_machine',
  /** 只在测试里用：原样回参数，用来打通链路 */
  echo: 'litch_echo',
} as const

/** 握手时 `capabilities.litchClientTools` 的形状。没声明 clientTools 扩展时这一项不看 */
export interface ClientToolsDeclaration {
  /** 这条连接能执行的命名空间。每个都必须以 CLIENT_TOOL_NAMESPACE_PREFIX 开头 */
  namespaces: string[]
  /** Litch 桌面端报的自己是哪台（声明了 litch_machine 时带）。设备进程按它列出、挑选桌面端 */
  desktop?: ClientToolsDesktopInfo
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
  /** 访问范围挡住了（litch_machine 碰到禁止位置），说明里写是哪条规则 */
  | 'blocked'
  /** 不知道交给哪台：命令行调用找不到会话、又连着不止一台桌面端，说明里列出各台的主机名 */
  | 'ambiguous'

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

// —— 不经动态工具的调用 ——
// 装了适配器的远程设备上，`codex-harness-adapter machine …`（短名 litch-machine）连本机的 device.sock，
// 调 CLIENT_TOOL_METHOD.invoke；设备进程挑一条声明过这个命名空间的 Litch 连接，向它发 CLIENT_TOOL_METHOD.call。
// 两样都是我们的扩展（clientTools），只发给、只接受声明过的连接。

export const CLIENT_TOOL_METHOD = {
  /** 客户端（命令行）→ 设备进程：请连着的 Litch 执行一次工具调用。应答就是执行的结果 */
  invoke: 'litch/clientTool/invoke',
  /** 设备进程 → Litch（服务端请求）：执行一次不来自回合的工具调用。应答是 ClientToolCallResponse */
  call: 'litch/clientTool/call',
  /**
   * 客户端（命令行）→ 设备进程：现在连着、能执行客户端工具的 Litch 桌面端有哪些。应答是
   * ClientToolDesktopsResult。命令行的说明开头要写桌面端的名字，有歧义时也按它列
   */
  desktops: 'litch/clientTool/desktops',
} as const

/** `litch/clientTool/desktops` 的应答 */
export interface ClientToolDesktopsResult {
  /** 按连上的先后。没报 desktop 的连接 hostname 是空字符串 */
  desktops: (ClientToolsDesktopInfo & { namespaces: string[] })[]
}

/** `litch/clientTool/invoke` 的参数 */
export interface ClientToolInvokeParams {
  namespace: string
  tool: string
  arguments: unknown
  /**
   * 调用者所在的会话，从环境变量里找到的（CODEX_THREAD_ID、LITCH_THREAD_ID）。找不到是 null：
   * 卡片放进桌面端的全局待处理
   */
  threadId: string | null
  /**
   * 指定交给哪台桌面端（Litch 连接报的主机名）。不给时：找得到会话就交给发起那个回合的那台；
   * 找不到、又连着不止一台声明了的，回 ambiguous 失败，说明里列出各台的主机名，好让调用方指定
   */
  desktop?: string
}

/** `litch/clientTool/call` 的参数：和 item/tool/call 同形，但不一定来自某个回合 */
export interface ClientToolDetachedCallParams {
  /** 设备进程给的标识，取消时按它对 */
  callId: string
  namespace: string
  tool: string
  arguments: unknown
  /** 找到了会话就有，否则 null */
  threadId: string | null
  /** 这个会话当时在跑的回合，不知道是 null */
  turnId: string | null
  /** 调用者是哪个 harness 的进程，设备进程不知道就是 null（只用来显示） */
  harness: string | null
}

/** 握手时 Litch 连接在 capabilities.litchClientTools 里额外报的：这台桌面端的主机名（ambiguous 时列出、指定交给哪台时用） */
export interface ClientToolsDesktopInfo {
  hostname: string
  /** 给人看的名字，比如“Song 的 MacBook”。没有就用主机名 */
  name?: string
}
