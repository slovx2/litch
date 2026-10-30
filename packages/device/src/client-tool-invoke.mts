// 不经动态工具的客户端工具调用（clientTools 扩展的 litch/clientTool/invoke）。
// 调用者是这台机器上的一个进程（适配器的 `machine` 子命令，短名 litch-machine），不是 Litch：
// 它连上聚合面，不握手也行（握手要为它连一遍每个 harness 的运行时，白花一两秒），直接调 invoke。
// 这里挑一条声明过这个命名空间的 Litch 连接，向它发服务端请求 litch/clientTool/call，应答原样交回调用者。
//
// 挑执行方：
//   1. 给了 desktop：只在主机名（或名字）对得上的连接里挑；
//   2. 有会话号：发起这个会话当前回合的连接，否则订阅着这个会话、最早订阅的那条（和 item/tool/call 一个规矩）；
//   3. 还挑不出：只有一条就交给它；不止一条回 ambiguous，说明里列出各台的主机名，让调用者指定；
//   4. 一条都没有：回 noExecutor。
// 交出去以后：调用者断开就撤回（serverRequest/resolved，卡片收掉）；执行方断开就替它回 failed，不改交给别人。
import {
  CLIENT_TOOL_METHOD,
  type ClientToolCallResponse,
  type ClientToolDesktopsResult,
  type ClientToolDetachedCallParams,
  type ClientToolInvokeParams,
  clientToolFailure,
  isClientToolNamespace,
} from '../../protocol/src/client-tools.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ClientToolPeer, ClientToolRouter } from './client-tools.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { type Frame, isObject, type RpcId } from './wire.mjs'

/** 发起调用的那条连接。只用它认“是谁的调用”，断开时撤回 */
export interface InvokeCaller {
  readonly id: string
}

/** 执行方的应答：成功的结果原样交回；执行方回的 JSON-RPC 错误也原样交回 */
export type InvokeOutcome =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }

interface Pending {
  caller: InvokeCaller
  peer: ClientToolPeer
  facingId: RpcId
  threadId: string | null
  namespace: string
  resolve(outcome: InvokeOutcome): void
}

export interface ClientToolInvokerOptions {
  router: ClientToolRouter
  index: ThreadIndex
  log(line: string): void
}

/** 给人看的一台桌面端：名字（主机名），没报名字的只有主机名 */
function label(peer: ClientToolPeer): string {
  const desktop = peer.desktop
  if (!desktop?.hostname) return `（没报主机名的连接 ${peer.id.slice(0, 8)}）`
  return desktop.name && desktop.name !== desktop.hostname
    ? `${desktop.name}（${desktop.hostname}）`
    : desktop.hostname
}

/** 主机名或名字对得上（不分大小写；主机名带不带 .local 都算） */
function matches(peer: ClientToolPeer, wanted: string): boolean {
  const desktop = peer.desktop
  if (!desktop) return false
  const norm = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/\.local$/, '')
  const target = norm(wanted)
  return norm(desktop.hostname) === target || (!!desktop.name && norm(desktop.name) === target)
}

function parseParams(params: unknown): ClientToolInvokeParams {
  if (!isObject(params)) throw new ProtocolError(-32602, '参数必须是对象')
  const { namespace, tool, threadId, desktop } = params
  if (typeof namespace !== 'string' || !isClientToolNamespace(namespace))
    throw new ProtocolError(-32602, 'namespace 必须是以 litch_ 开头的字符串')
  if (typeof tool !== 'string' || !tool) throw new ProtocolError(-32602, 'tool 必须是非空字符串')
  if (threadId !== null && threadId !== undefined && typeof threadId !== 'string')
    throw new ProtocolError(-32602, 'threadId 必须是字符串或 null')
  if (desktop !== undefined && (typeof desktop !== 'string' || !desktop.trim()))
    throw new ProtocolError(-32602, 'desktop 必须是非空字符串')
  return {
    namespace,
    tool,
    arguments: params.arguments ?? {},
    threadId: typeof threadId === 'string' && threadId ? threadId : null,
    ...(typeof desktop === 'string' ? { desktop } : {}),
  }
}

export class ClientToolInvoker {
  private readonly options: ClientToolInvokerOptions
  private readonly pending = new Map<string, Pending>()
  private sequence = 0

  constructor(options: ClientToolInvokerOptions) {
    this.options = options
  }

  /** litch/clientTool/desktops：现在连着、声明了客户端工具的 Litch 桌面端 */
  desktops(): ClientToolDesktopsResult {
    const peers = this.options.router.executors(null)
    return {
      desktops: peers.map((peer) => ({
        hostname: peer.desktop?.hostname ?? '',
        ...(peer.desktop?.name ? { name: peer.desktop.name } : {}),
        namespaces: [...peer.clientToolNamespaces],
      })),
    }
  }

  /** litch/clientTool/invoke。参数不对抛 ProtocolError；挑不出执行方时回失败答复（不是错误） */
  invoke(caller: InvokeCaller, raw: unknown): Promise<InvokeOutcome> {
    const params = parseParams(raw)
    const { router, index } = this.options
    let candidates = router
      .executors(params.namespace)
      .filter((peer) => peer.clientToolNamespaces.supports(params.namespace, params.tool))
    if (params.desktop !== undefined) {
      const all = candidates
      candidates = all.filter((peer) => matches(peer, params.desktop as string))
      if (candidates.length === 0)
        return Promise.resolve({
          result: clientToolFailure(
            'noExecutor',
            all.length
              ? `没有连着主机名是 ${params.desktop} 的 Litch 桌面端。现在连着的是：${all.map(label).join('、')}。请换一个主机名再试。`
              : `这台设备现在没有连着能执行 ${params.namespace} 的 Litch 桌面端，这次调用没有执行。请用户打开 Litch 并连上这台设备后再试。`,
          ),
        })
    }
    const found = params.threadId
      ? router.executorForThread(params.threadId, params.namespace, candidates)
      : { peer: null, harness: null, turnId: null }
    let peer = found.peer
    if (!peer && candidates.length === 1) peer = candidates[0] ?? null
    if (!peer && candidates.length > 1)
      return Promise.resolve({
        result: clientToolFailure(
          'ambiguous',
          `这台设备连着不止一台 Litch 桌面端，${params.threadId ? '而且从这个会话找不到是哪一台发起的' : '而且不知道调用来自哪个会话'}，不知道交给哪台：${candidates.map(label).join('、')}。请指定主机名再试（命令行加 --desktop <主机名>）。`,
        ),
      })
    if (!peer)
      return Promise.resolve({
        result: clientToolFailure(
          'noExecutor',
          `这台设备现在没有连着能执行 ${params.namespace} 的 Litch 桌面端，这次调用没有执行。请告诉用户打开 Litch 并连上这台设备后再试，不要反复重试。`,
        ),
      })
    const harness =
      found.harness ?? (params.threadId ? index.lookup(params.threadId) : null) ?? null
    return this.deliver(caller, peer, params, harness, found.turnId)
  }

  private deliver(
    caller: InvokeCaller,
    peer: ClientToolPeer,
    params: ClientToolInvokeParams,
    harness: string | null,
    turnId: string | null,
  ): Promise<InvokeOutcome> {
    const callId = `invoke-${++this.sequence}`
    const call: ClientToolDetachedCallParams = {
      callId,
      namespace: params.namespace,
      tool: params.tool,
      arguments: params.arguments,
      threadId: params.threadId,
      turnId,
      harness,
    }
    const frame: Frame = {
      id: `litch:invoke:${this.sequence}`,
      method: CLIENT_TOOL_METHOD.call,
      params: call,
    }
    return new Promise((resolve) => {
      const facingId = peer.deliverClientTool('invoke', frame, (reply) => {
        if (!this.pending.delete(callId)) return
        resolve(
          isObject(reply.error)
            ? { error: reply.error as { code: number; message: string; data?: unknown } }
            : { result: reply.result ?? null },
        )
      })
      this.pending.set(callId, {
        caller,
        peer,
        facingId,
        threadId: params.threadId,
        namespace: params.namespace,
        resolve,
      })
      this.options.log(
        `命令行调用 ${params.namespace}.${params.tool}（会话 ${params.threadId ?? '不明'}）交给 ${label(peer)}`,
      )
    })
  }

  /** 发起调用的连接断开了：它还在等的调用撤回，执行方那边的卡片收掉 */
  callerLeft(caller: InvokeCaller): void {
    for (const [callId, entry] of this.pending) {
      if (entry.caller !== caller) continue
      this.pending.delete(callId)
      if (entry.peer.ready) entry.peer.withdrawClientTool(entry.facingId, entry.threadId)
      this.options.log(`命令行调用 ${entry.namespace} 的调用者断开了，已撤回`)
    }
  }

  /** 执行方断开了：交给它的调用替它回 failed */
  peerLeft(peer: ClientToolPeer): void {
    for (const [callId, entry] of this.pending) {
      if (entry.peer !== peer) continue
      this.pending.delete(callId)
      entry.resolve({
        result: clientToolFailure(
          'failed',
          `执行这次调用的 Litch 桌面端断开了连接，${entry.namespace} 的这次调用没有结果，可能只做了一半。请先确认它的状态再决定要不要重做。`,
        ) satisfies ClientToolCallResponse,
      })
    }
  }
}
