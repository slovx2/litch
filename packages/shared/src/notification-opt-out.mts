// 握手参数里的 `capabilities.optOutNotificationMethods`：客户端列出不想收的通知，这条连接上之后就不发。
// 三个引擎的入口共用。语义照开源 codex 的 app-server（rust-v0.157.1 的 `app-server/src/transport.rs`，
// `should_skip_notification_for_connection`）：按连接记、方法名精确匹配、只拦通知；
// 应答、错误和服务端发起的请求照发，名单里不认识的名字不报错。
import type { RpcPeer, WireMessage } from './types.mjs'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** 每条连接现行的退订名单。表里有这条连接，就是它的发送口已经装上了过滤 */
const optedOut = new WeakMap<RpcPeer, Set<string>>()

/**
 * 握手参数（`initialize` 的 params）里退订的通知方法名。
 * 没带、是 null、带的不是数组，都当作一个也没退订；数组里不是字符串的项不算。
 */
export function optOutNotificationMethods(initializeParams: unknown): Set<string> {
  const listed = record(record(initializeParams).capabilities).optOutNotificationMethods
  if (!Array.isArray(listed)) return new Set()
  return new Set(listed.filter((name): name is string => typeof name === 'string'))
}

/** 这条消息是不是名单上的通知。带 `id` 的是应答或服务端请求，不看名单 */
export function isOptedOut(methods: ReadonlySet<string>, message: WireMessage): boolean {
  return 'method' in message && !('id' in message) && methods.has(message.method)
}

/**
 * 入口处理握手时调：记下这条连接退订的通知，之后经它的 `send` 出去的通知里，名单上的直接丢掉。
 * 拦在连接的发送口上（上游也是在出口过滤的）：引擎自己发的、共用层发的（终端输出、文件变化、找文件的结果）
 * 都经过这里，不用每个发通知的地方各查一遍；入口里按通知做的记账不受影响。
 * 同一条连接再握手一次只换名单，不重复装。
 */
export function applyNotificationOptOut(peer: RpcPeer, initializeParams: unknown): void {
  const installed = optedOut.has(peer)
  optedOut.set(peer, optOutNotificationMethods(initializeParams))
  if (installed) return
  const send = peer.send.bind(peer)
  peer.send = (message) => {
    const methods = optedOut.get(peer)
    if (methods && isOptedOut(methods, message)) return
    send(message)
  }
}
