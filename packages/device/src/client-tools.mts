// 原生 codex 的客户端工具调用由设备进程挑执行方（clientTools 扩展，protocol/extensions/client-tools.json）。
// 适配器的入口（claude-code、pi）自己按扩展挑，发来的调用只到选中的那条连接，设备进程原样转发就行；
// 原生 codex 不认识这项扩展，把同一个请求（请求号相同）发给订阅着会话的每条连接，
// 在设备进程里就是每条客户端连接各自的上游连接上各一份。这里把这几份并成一次调用：
//   - 按扩展的规矩挑一条客户端连接，只转给它一份，别的那几份不转，也不替它们答；
//   - 一条声明过的都没有：替这次调用回 noExecutor 失败；
//   - 执行方答了：答复交给原生 codex，其余几份就此作废；
//   - 执行方断开：替它回 failed；回合结束、codex 说这个请求有结果了、上游全断了：这次调用算了结，
//     执行方的卡片收掉。
// 依据（codex 0.160.0 实测，源码 rust-v0.160.0-alpha.3 的 app-server/src/outgoing_message.rs）：
//   - 服务端请求的请求号整个 app-server 一份，发给每条订阅连接的是同一个；答复按请求号认，
//     从哪条连接回去都算数（take_connection_callback 不看连接），所以可以从执行方自己的上游连接回，
//     哪怕它没订阅、没收到那一份；
//   - 答了之后它不发 serverRequest/resolved（实测）；有连接恢复会话时，还在等的请求会补发给它；
//   - turn/start 不会让发起的连接订阅会话（实测），所以“发起回合的连接”要设备进程自己记。
import {
  type ClientToolCallResponse,
  type ClientToolsDesktopInfo,
  clientToolFailure,
} from '../../protocol/src/client-tools.mjs'
import {
  noClientToolExecutor,
  pickClientToolExecutor,
} from '../../shared/src/client-tool-executor.mjs'
import type { DeviceTools } from './device-tools.mjs'
import type { UpstreamLink } from './upstream.mjs'
import { type Frame, idKey, isObject, type RpcId } from './wire.mjs'

/** 一条客户端连接在这件事里要做的几样（ClientSession 实现） */
export interface ClientToolPeer {
  readonly id: string
  /** 握手完成、还没断开 */
  readonly ready: boolean
  /** 握手时声明能执行的命名空间。没声明 clientTools 扩展的是空的 */
  readonly clientToolNamespaces: ReadonlySet<string>
  /** 握手时报的“我是哪台桌面端”（litchClientTools.desktop）。没报是 null */
  readonly desktop: ClientToolsDesktopInfo | null
  /**
   * 把一次调用转给这条连接的客户端。frame 是上游发来的原样请求；客户端的答复交给 onAnswer。
   * 返回客户端看到的请求号（和这条连接上别的待答请求撞了时会换一个）
   */
  deliverClientTool(harness: string, frame: Frame, onAnswer: (reply: Frame) => void): RpcId
  /** 这次调用了结了（不是它答的）：告诉客户端这个请求有结果了，卡片收掉。不来自会话的调用 threadId 是 null */
  withdrawClientTool(facingId: RpcId, threadId: string | null): void
  /** 这条连接通往某个 harness 的上游连接 */
  upstream(harness: string): UpstreamLink | null
}

interface Call {
  key: string
  harness: string
  upstreamId: RpcId
  threadId: string
  turnId: string
  namespace: string
  frame: Frame
  /** 收到这一份的上游连接和它所属的客户端连接，按到达的先后 */
  copies: { link: UpstreamLink; peer: ClientToolPeer }[]
  executor: ClientToolPeer | null
  facingId: RpcId | null
  /** 还没挑出执行方、在等别的几份到齐的计时 */
  grace: NodeJS.Timeout | null
}

/** 设备进程自己执行的那几个命名空间（device-tools.mts 的注册表） */
export type DeviceToolDispatch = Pick<DeviceTools, 'has' | 'dispatch'>

export interface ClientToolRouterOptions {
  /**
   * 按已知的发起者和订阅者挑不出执行方时，等其余几份到齐的工夫（毫秒）。几份是 codex 一口气发给
   * 各条连接的，各走各的套接字，前后差几毫秒；收到某一份的连接本身就说明它订阅着（比如子代理的会话
   * 一建出来就挂到所有连接上，设备进程看不到订阅的应答），等这一下免得在声明过的那条的那份到达之前
   * 就判了“没人能执行”
   */
  graceMs: number
  log(line: string): void
  /** 设备工具（litch_tasks……）的调用由设备进程自己答。没给（测试）就当场回 noExecutor */
  deviceTools?: DeviceToolDispatch
}

const sep = '\u0000'

export class ClientToolRouter {
  private readonly options: ClientToolRouterOptions
  private readonly peers = new Set<ClientToolPeer>()
  /** 订阅着会话的连接，按订阅的先后。键：harness + 会话 */
  private readonly subscribers = new Map<string, ClientToolPeer[]>()
  /** 发起回合的连接。键：harness + 回合 */
  private readonly starters = new Map<string, ClientToolPeer>()
  /** 还没了结的调用。键：harness + 会话 + callId */
  private readonly calls = new Map<string, Call>()
  /** 请求号到调用的键，认 codex 发来的 serverRequest/resolved 用。键：harness + 请求号 */
  private readonly byRequest = new Map<string, string>()
  /**
   * 已经了结的调用（键同 calls）到它的回合：之后再到的那几份（迟到的、恢复会话时补发的）直接丢掉。
   * 回合结束时清掉
   */
  private readonly done = new Map<string, { harness: string; turnId: string; request: string }>()
  /**
   * 会话正在跑的回合（turn/started 时记，turn/completed 时清）。键：会话；会话号各 harness 之间不重。
   * 命令行的调用（litch/clientTool/invoke）只带会话号，按它找发起这个回合的连接（client-tool-invoke.mts）
   */
  private readonly running = new Map<string, { harness: string; turnId: string }>()

  constructor(options: ClientToolRouterOptions) {
    this.options = options
  }

  /** 连接握手完成 */
  join(peer: ClientToolPeer): void {
    this.peers.add(peer)
  }

  /** 这条连接订阅了会话（新建、恢复、分叉的应答回来了）。重复订阅不改先后 */
  subscribed(peer: ClientToolPeer, harness: string, threadId: string): void {
    const key = harness + sep + threadId
    const list = this.subscribers.get(key) ?? []
    if (!list.includes(peer)) list.push(peer)
    this.subscribers.set(key, list)
  }

  unsubscribed(peer: ClientToolPeer, harness: string, threadId: string): void {
    const key = harness + sep + threadId
    const list = this.subscribers.get(key)?.filter((one) => one !== peer) ?? []
    if (list.length) this.subscribers.set(key, list)
    else this.subscribers.delete(key)
  }

  /** 这条连接发起了一个回合（turn/start 的应答回来了） */
  turnStarted(peer: ClientToolPeer, harness: string, turnId: string): void {
    this.starters.set(harness + sep + turnId, peer)
  }

  /** 原生 codex 发来一份 litch_ 命名空间的 item/tool/call。这一份不再往下转，怎么办都在这里 */
  offer(peer: ClientToolPeer, link: UpstreamLink, frame: Frame, upstreamId: RpcId): void {
    const params = isObject(frame.params) ? frame.params : {}
    // 设备进程自己执行的命名空间不挑客户端连接
    if (this.options.deviceTools?.has(params.namespace)) {
      this.device(link, frame, upstreamId)
      return
    }
    const threadId = typeof params.threadId === 'string' ? params.threadId : ''
    const callId = typeof params.callId === 'string' ? params.callId : idKey(upstreamId)
    const key = [link.harness, threadId, callId].join(sep)
    if (this.done.has(key)) return
    let call = this.calls.get(key)
    if (!call) {
      call = {
        key,
        harness: link.harness,
        upstreamId,
        threadId,
        turnId: typeof params.turnId === 'string' ? params.turnId : '',
        namespace: String(params.namespace),
        frame,
        copies: [],
        executor: null,
        facingId: null,
        grace: null,
      }
      this.calls.set(key, call)
      this.byRequest.set(link.harness + sep + idKey(upstreamId), key)
    }
    if (!call.copies.some((copy) => copy.link === link)) call.copies.push({ link, peer })
    if (call.executor) return
    const executor = this.pick(call)
    if (executor) this.deliver(call, executor)
    else if (!call.grace)
      call.grace = setTimeout(() => {
        const current = this.calls.get(key)
        if (!current || current.executor) return
        current.grace = null
        const late = this.pick(current)
        if (late) this.deliver(current, late)
        else this.finish(current, noClientToolExecutor(current.namespace), '没有能执行的连接')
      }, this.options.graceMs)
  }

  /**
   * 设备工具的一份调用（任何上游来的）：执行方是设备进程自己，不挑客户端连接，从收到它的这条上游连接答。
   * 原生 codex 发给每条订阅连接的那几份由注册表按 callId 只答第一份（device-tools.mts）
   */
  device(link: UpstreamLink, frame: Frame, upstreamId: RpcId): void {
    const params = isObject(frame.params) ? frame.params : {}
    const reply = (result: ClientToolCallResponse) => {
      if (link.available) link.reply(JSON.stringify({ id: upstreamId, result }))
    }
    if (this.options.deviceTools) this.options.deviceTools.dispatch(link.harness, frame, reply)
    else reply(noClientToolExecutor(String(params.namespace)))
  }

  /** 发起者优先，其次订阅者（设备进程看到的先后），最后是收到了某一份的连接（到达的先后） */
  private pick(call: Call): ClientToolPeer | null {
    const starter = this.starters.get(call.harness + sep + call.turnId)
    const ordered = [...(this.subscribers.get(call.harness + sep + call.threadId) ?? [])]
    for (const { peer } of call.copies) if (!ordered.includes(peer)) ordered.push(peer)
    return pickClientToolExecutor(
      call.namespace,
      starter?.ready ? starter : null,
      ordered.filter((peer) => peer.ready),
      (peer) => peer.clientToolNamespaces,
    )
  }

  private deliver(call: Call, executor: ClientToolPeer): void {
    if (call.grace) clearTimeout(call.grace)
    call.grace = null
    call.executor = executor
    call.facingId = executor.deliverClientTool(call.harness, call.frame, (reply) => {
      if (this.calls.get(call.key) !== call) return
      this.send(call, { ...reply, id: call.upstreamId })
      this.settle(call)
    })
  }

  /**
   * 替这次调用答原生 codex。执行方自己的上游连接优先（它答的，从它那里回最自然），
   * 不行就用收到过某一份的、再不行用任何一条还连着这个 harness 的。都不在了返回 false
   */
  private send(call: Call, reply: Frame): boolean {
    const link = this.replyLink(call)
    if (!link) return false
    link.reply(JSON.stringify(reply))
    return true
  }

  private replyLink(call: Call): UpstreamLink | null {
    const candidates: (UpstreamLink | null | undefined)[] = [
      call.executor?.upstream(call.harness),
      ...call.copies.map((copy) => copy.link),
      ...[...this.peers].map((peer) => peer.upstream(call.harness)),
    ]
    return candidates.find((link): link is UpstreamLink => !!link?.available) ?? null
  }

  /** 替这次调用回一个结果并了结。执行方那边要是还挂着卡片，收掉 */
  private finish(call: Call, result: unknown, why: string): void {
    const sent = this.send(call, { id: call.upstreamId, result })
    this.options.log(
      `${call.harness} 的客户端工具调用 ${call.namespace}（会话 ${call.threadId}）${why}，${sent ? '已替它回失败' : '上游已不在，没法回'}`,
    )
    this.withdraw(call)
  }

  private withdraw(call: Call): void {
    const { executor, facingId } = call
    this.settle(call)
    if (executor && facingId !== null && executor.ready)
      executor.withdrawClientTool(facingId, call.threadId)
  }

  private settle(call: Call): void {
    if (call.grace) clearTimeout(call.grace)
    call.grace = null
    this.calls.delete(call.key)
    this.done.set(call.key, {
      harness: call.harness,
      turnId: call.turnId,
      request: call.harness + sep + idKey(call.upstreamId),
    })
  }

  /** 原生 codex 说这个请求有结果了。是这里在管的调用就返回 true：这条通知不再往客户端转 */
  resolved(link: UpstreamLink, requestId: RpcId): boolean {
    const request = link.harness + sep + idKey(requestId)
    const key = this.byRequest.get(request)
    if (key === undefined) return false
    const call = this.calls.get(key)
    if (call) this.withdraw(call)
    return true
  }

  /** 回合结束：这个回合里还没了结的调用就此了结，记着的发起者和“已了结”一起清掉 */
  turnEnded(harness: string, turnId: string): void {
    for (const call of [...this.calls.values()])
      if (call.harness === harness && call.turnId === turnId) this.withdraw(call)
    for (const [key, entry] of this.done)
      if (entry.harness === harness && entry.turnId === turnId) {
        this.done.delete(key)
        this.byRequest.delete(entry.request)
      }
    this.starters.delete(harness + sep + turnId)
    for (const [threadId, turn] of this.running)
      if (turn.harness === harness && turn.turnId === turnId) this.running.delete(threadId)
  }

  /** 会话的一个回合开始了（turn/started 通知；每条订阅着的连接各收到一份，记一次就够） */
  turnBegan(harness: string, threadId: string, turnId: string): void {
    this.running.set(threadId, { harness, turnId })
  }

  /** 还连着、声明了这个命名空间的连接，按连上的先后。namespace 为 null：声明了任何一个的都算 */
  executors(namespace: string | null): ClientToolPeer[] {
    return [...this.peers].filter(
      (peer) =>
        peer.ready &&
        (namespace === null
          ? peer.clientToolNamespaces.size > 0
          : peer.clientToolNamespaces.has(namespace)),
    )
  }

  /**
   * 按会话挑执行方（命令行调用用）：发起这个会话当前回合的连接，否则订阅着这个会话的连接里最早订阅的；
   * 都得还连着、声明了这个命名空间。candidates 给了就只在其中挑。挑不出返回 null。
   * turnId、harness 是知道的话这个会话当前的回合和所属的 harness（不论挑没挑出来）
   */
  executorForThread(
    threadId: string,
    namespace: string,
    candidates: readonly ClientToolPeer[],
  ): { peer: ClientToolPeer | null; harness: string | null; turnId: string | null } {
    const turn = this.running.get(threadId) ?? null
    const starter = turn ? (this.starters.get(turn.harness + sep + turn.turnId) ?? null) : null
    const subscribers: ClientToolPeer[] = []
    let harness = turn?.harness ?? null
    for (const [key, list] of this.subscribers) {
      const at = key.indexOf(sep)
      if (key.slice(at + 1) !== threadId) continue
      harness ??= key.slice(0, at)
      for (const peer of list) if (!subscribers.includes(peer)) subscribers.push(peer)
    }
    const allowed = (peer: ClientToolPeer) => peer.ready && candidates.includes(peer)
    const peer = pickClientToolExecutor(
      namespace,
      starter && allowed(starter) ? starter : null,
      subscribers.filter(allowed),
      (one) => one.clientToolNamespaces,
    )
    return { peer, harness, turnId: turn?.turnId ?? null }
  }

  /** 一条上游连接断了：它收到的那几份作废；一次调用再也没有路可以答的，就此了结 */
  dropped(link: UpstreamLink): void {
    for (const call of [...this.calls.values()]) {
      call.copies = call.copies.filter((copy) => copy.link !== link)
      if (!this.replyLink(call)) this.withdraw(call)
    }
  }

  /** 客户端连接断开：订阅、发起者里去掉它；它在执行的调用替它回 failed */
  left(peer: ClientToolPeer): void {
    this.peers.delete(peer)
    for (const [key, list] of this.subscribers) {
      const rest = list.filter((one) => one !== peer)
      if (rest.length) this.subscribers.set(key, rest)
      else this.subscribers.delete(key)
    }
    for (const [key, starter] of this.starters) if (starter === peer) this.starters.delete(key)
    for (const call of [...this.calls.values()]) {
      call.copies = call.copies.filter((copy) => copy.peer !== peer)
      if (call.executor === peer)
        this.finish(
          call,
          clientToolFailure(
            'failed',
            `执行这次调用的 Litch 桌面端断开了连接，${call.namespace} 的这次调用没有结果，可能只做了一半。请告诉用户重新在 Litch 里打开这个会话后再试。`,
          ),
          '的执行方断开了',
        )
    }
  }
}
