// 上游说的是哪一种“话”。聚合面后面的运行时有两种：
//   - 适配器的运行时（Claude Code、Pi、dsh）：认识我们的协议扩展，自己在 `runtime/info` 里报声明；
//   - 原生的 codex（native-codex.mts）：只说标准的 Codex 协议，不认识我们加的任何东西。
// 两种上游在路由上完全一样（按会话归属、按 harness 参数转发，通知和服务端请求原样带回）；
// 不一样的只有下面这几处，都收在这个接口后面，路由那几个文件不用知道对面是谁。
import { HARNESS_CONFIG_METHOD } from '../../protocol/src/harness-config.mjs'
import type { InstructionContext, PreparedInstructions } from './codex-instructions.mjs'
import {
  HarnessConfigError,
  type HarnessConfigTranslator,
  type TranslatorContext,
  text,
} from './harness-config.mjs'
import { isObject, type RpcError } from './wire.mjs'

/** 握手之后向这个上游问一句 */
export type Ask = (method: string, params: unknown) => Promise<unknown>

export interface UpstreamDialect {
  /** 握手时带给上游的参数。given 是客户端握手时给聚合面的那一份 */
  initializeParams(given: unknown): unknown
  /**
   * 握手之后取这个上游的声明，形状就是适配器的 `runtime/info` 应答（引擎名、版本、能力位、权限预设……）。
   * 拿不到返回 null，不抛错：这时聚合面只报得出名字和握手应答里的版本。
   */
  describe(initialized: unknown, ask: Ask): Promise<Record<string, unknown> | null>
  /**
   * 客户端的一个请求转给上游之前（聚合面自己的参数已经摘掉）。要改参数就返回新的一份，不改返回 null。
   */
  outgoing(method: string, params: Record<string, unknown>): Record<string, unknown> | null
  /**
   * 上游对一个转过去的请求回了错误。要换成别的错误就返回它；返回 null 是原样带给客户端。
   */
  rejection(harness: string, method: string, error: RpcError): RpcError | null
  /**
   * 上游发起的请求（审批、提问）转给客户端之前。declares 说这条客户端连接握手时声明没声明某个扩展。
   * 就地改了 params 返回 true。
   */
  serverRequest(
    method: string,
    params: Record<string, unknown>,
    declares: (extension: string) => boolean,
  ): boolean
  /**
   * 客户端工具（clientTools 扩展）的调用由设备进程挑执行方：这个上游不认识那项扩展，
   * 会把同一个调用发给所有订阅连接（client-tools.mts）。适配器的运行时自己挑，不用设
   */
  clientToolsByDevice?: boolean
  /**
   * harness 详情设置（harnessConfig 扩展）：这个上游不认识 `litch/harness/*`，由设备进程替它答。
   * 每条客户端连接建一个翻译器。适配器的运行时自己实现这些方法，不用设（聚合面原样转过去）
   */
  harnessConfig?(context: TranslatorContext): HarnessConfigTranslator
  /**
   * 建会话、恢复、分叉之前补齐开发者指令（codex-instructions.mts）：要补的返回补好的参数（异步，可能要先问上游），
   * 不用补的返回 null，照常同步转发。只有原生 codex 设：适配器的运行时自己把规则拼进系统提示
   */
  instructions?(
    method: string,
    params: Record<string, unknown>,
    context: InstructionContext,
  ): Promise<PreparedInstructions> | null
}

/**
 * 客户端退订的通知由聚合面自己拦（relay.mts：先记账，再查退订），名单不带给上游：
 * 上游照名单在源头就不发的话，会话出现、删除、归档这些聚合面要记的账也跟着没了。
 */
export function withoutOptOut(given: unknown): unknown {
  if (!isObject(given) || !isObject(given.capabilities)) return given
  const { optOutNotificationMethods: _ours, ...capabilities } = given.capabilities
  return { ...given, capabilities }
}

const MODEL_METHODS = new Set<string>([
  HARNESS_CONFIG_METHOD.modelsRead,
  HARNESS_CONFIG_METHOD.modelsWrite,
])

/**
 * 模型清单（litch/harness/models/*）只有 config/read 报了 modelCatalog 的 harness 有。没实现的引擎各回各的
 * “不认识”：Claude、Pi 是 -32601，dsh 是这个扩展的 notFound。统一换成这个扩展的 unavailable，客户端一种认法
 */
export function noModelCatalog(harness: string, method: string, error: RpcError): RpcError | null {
  if (!MODEL_METHODS.has(method)) return null
  const unknown =
    error.code === -32601 ||
    (error.code === -32000 && isObject(error.data) && error.data.litch === 'notFound')
  if (!unknown) return null
  const replaced = new HarnessConfigError(
    'unavailable',
    harness,
    text(`${harness} 没有模型清单`, `${harness} has no model list`),
  )
  return { code: replaced.code, message: replaced.message, data: replaced.data }
}

/** 适配器的运行时：握手参数除了退订名单都带过去，声明问它自己要，别的什么都不用改 */
export const ADAPTER_DIALECT: UpstreamDialect = {
  initializeParams: withoutOptOut,
  describe: (_initialized, ask) =>
    ask('runtime/info', {}).then(
      (result) => (isObject(result) ? result : null),
      // 旧版的适配器不认识这个方法：只有握手应答可用
      () => null,
    ),
  outgoing: () => null,
  rejection: noModelCatalog,
  serverRequest: () => false,
}

/** 带 dynamicTools 的方法。上游只有 thread/start 收它；恢复、分叉真带了也照样处理（上游悄悄丢掉） */
const DYNAMIC_TOOL_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork'])

/** 一个工具都没有的命名空间（比如只带 instructions 的 litch_presentation） */
export const isEmptyNamespace = (spec: unknown): boolean =>
  isObject(spec) &&
  spec.type === 'namespace' &&
  Array.isArray(spec.tools) &&
  spec.tools.length === 0

/**
 * 原生 codex 转发前：去掉一个工具都没有的命名空间，连同它带的 instructions。上游 validate_dynamic_tools
 * 对这种命名空间直接报错（must contain at least one tool），带上一个整个 thread/start 都会失败；
 * 它的 instructions 也不并进开发者指令：Litch 只把这种命名空间（呈现风格）给不是原生 codex 的 harness。
 * 不改返回 null
 */
export function withoutEmptyNamespaces(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!DYNAMIC_TOOL_METHODS.has(method) || !Array.isArray(params.dynamicTools)) return null
  if (!params.dynamicTools.some(isEmptyNamespace)) return null
  const dynamicTools = params.dynamicTools.filter((spec) => !isEmptyNamespace(spec))
  const { dynamicTools: _all, ...rest } = params
  return dynamicTools.length ? { ...rest, dynamicTools } : rest
}

/**
 * 原生 codex 转发前（clientTools 扩展，protocol/extensions/client-tools.json）：动态工具的命名空间上带的
 * instructions 摘掉，拼进 developerInstructions 的末尾，用户自己给的在前。不改返回 null。
 *
 * 依据（上游 rust-v0.162.0-alpha.20 源码）：
 *   - DynamicToolNamespaceSpec 没标 deny_unknown_fields，多出来的字段不报错、悄悄丢掉，到不了模型；
 *   - 开发者指令不随会话持久化：thread/start、thread/resume、thread/fork 的 developerInstructions 都只是这一次
 *     装载的配置覆盖（没给就回落到 config.toml），只在头一个回合的初始上下文里放一次，作为一条开发者消息记进
 *     会话历史，恢复、分叉时随历史回来，之后的回合不再重放；压缩后重建上下文时才按当时的配置再放一次。
 * 所以只在客户端发的 developerInstructions 里还没有这段规则时才拼：客户端恢复时把同一份（已经含着规则的）
 * 再带回来，不会叠两份。经设备进程转给原生 codex 的建会话、恢复、分叉先走 codex-instructions.mts
 * （底子取 config.toml、按会话记下、恢复分叉时补回），规则已经摘掉，到这里不再动。
 */
export function foldToolInstructions(
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!DYNAMIC_TOOL_METHODS.has(method) || !Array.isArray(params.dynamicTools)) return null
  let stripped = false
  const sections: string[] = []
  const dynamicTools = params.dynamicTools.map((spec) => {
    if (!isObject(spec) || spec.type !== 'namespace' || !('instructions' in spec)) return spec
    const { instructions, ...rest } = spec
    stripped = true
    const text = typeof instructions === 'string' ? instructions.trim() : ''
    const section = text ? `# Tool instructions: ${String(spec.name)}\n${text}` : ''
    if (section && !sections.includes(section)) sections.push(section)
    return rest
  })
  if (!stripped) return null
  const given = typeof params.developerInstructions === 'string' ? params.developerInstructions : ''
  const missing = sections.filter((section) => !given.includes(section))
  const developerInstructions = [given.trimEnd(), ...missing].filter(Boolean).join('\n\n')
  return {
    ...params,
    dynamicTools,
    ...(developerInstructions ? { developerInstructions } : {}),
  }
}
