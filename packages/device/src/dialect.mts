// 上游说的是哪一种“话”。聚合面后面的运行时有两种：
//   - 适配器的运行时（Claude Code、Pi、dsh）：认识我们的协议扩展，自己在 `runtime/info` 里报声明；
//   - 原生的 codex（native-codex.mts）：只说标准的 Codex 协议，不认识我们加的任何东西。
// 两种上游在路由上完全一样（按会话归属、按 harness 参数转发，通知和服务端请求原样带回）；
// 不一样的只有下面这几处，都收在这个接口后面，路由那几个文件不用知道对面是谁。
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
  rejection: () => null,
  serverRequest: () => false,
}
