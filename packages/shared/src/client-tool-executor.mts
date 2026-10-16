// 客户端工具（clientTools 扩展，protocol/extensions/client-tools.json）里“这次调用交给哪条连接”的规矩。
// Claude、Pi 两个入口和设备进程（替原生 codex 挑）用的是同一条：
//   1. 发起这个回合的连接，前提是它还连着、握手时声明了这个命名空间；
//   2. 否则是订阅着这个会话、声明了这个命名空间的连接里最早订阅的那条；
//   3. 都没有就当场回失败（noExecutor），不等人订阅，也不交给没声明的连接（官方桌面端、移动端）。
// 只管 `litch_` 开头的命名空间；别的命名空间照各入口原来的做法。
import {
  type ClientToolCallResponse,
  clientToolFailure,
  declaredClientToolNamespaces,
} from '../../protocol/src/client-tools.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'

export { isClientToolNamespace } from '../../protocol/src/client-tools.mjs'

/** 握手参数里这条连接声明能执行的命名空间。没声明 clientTools 扩展的连接是空的 */
export function clientToolNamespaces(initializeParams: unknown): ReadonlySet<string> {
  const capabilities =
    initializeParams && typeof initializeParams === 'object'
      ? (initializeParams as Record<string, unknown>).capabilities
      : undefined
  const listed =
    capabilities && typeof capabilities === 'object'
      ? (capabilities as Record<string, unknown>)[EXTENSIONS_CAPABILITY]
      : undefined
  const declared = Array.isArray(listed) && listed.includes(EXTENSION.clientTools)
  return new Set(declaredClientToolNamespaces(capabilities, declared))
}

/**
 * 挑执行方。starter：发起回合的连接（还连着才给，CLI 自己开的回合这类没有发起者的给 null）；
 * subscribers：订阅着会话、还连着的连接，按订阅的先后；namespacesOf：某条连接声明能执行的命名空间。
 * 一条都挑不出来返回 null。
 */
export function pickClientToolExecutor<T>(
  namespace: string,
  starter: T | null,
  subscribers: readonly T[],
  namespacesOf: (connection: T) => ReadonlySet<string>,
): T | null {
  if (starter !== null && namespacesOf(starter).has(namespace)) return starter
  return subscribers.find((connection) => namespacesOf(connection).has(namespace)) ?? null
}

/** 挑不出执行方时给模型的答复。说明要让模型知道这不是参数的问题、该怎么办 */
export function noClientToolExecutor(namespace: string): ClientToolCallResponse {
  return clientToolFailure(
    'noExecutor',
    `这个会话现在没有连着能执行 ${namespace} 的 Litch 桌面端，这次调用没有执行。请告诉用户在 Litch 里打开这个会话后再试；别的客户端执行不了这个工具，不要反复重试。`,
  )
}
