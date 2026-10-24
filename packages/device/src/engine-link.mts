// 设备进程自有的引擎连接（定时任务的运行、会话树的编排都用它）：不对应任何客户端连接，没有客户端在中间，
// 设备进程自己对引擎建会话、发回合、读会话。和聚合面上的上游连接（upstream.mts，每条客户端连接一组、断了自己重连）
// 不同，它断了就报 onClose，要再用由调用方重新开；和 side-link.mts（问几句就关）也不同，它一直听着。
// 通知交给 onNotification 的订阅者；引擎发来要答复的请求里：
//   - 设备工具（device-tools.mts 注册的 litch_ 命名空间）的 item/tool/call 交给注册表答；
//   - 别的（审批、提问、MCP 征询……）交给 onServerRequest 的订阅者看（会话树看子会话是不是在等用户），
//     这一版不答。只有一件事要替引擎做：这条连接订阅着会话，引擎把请求
//     也发给了它。对“没有连接可送就当场失败”的引擎（Pi、dsh、OpenCode、ACP 这几个用共享的
//     ServerRequests 的），这条连接一直拿着请求不答，请求就一直挂着、回合卡到时限。所以没有真正的客户端
//     连接拿着这条请求时，替引擎回它原来“没人可送”的结果；有客户端拿着就留给客户端，客户端都走了再回。
//     没人可送时本来就一直等着、等有连接来再送的引擎（Claude、原生 codex）照它原来的做法，不答。
//     例外是调用方用 claimRequests 接过去的（定时任务回合里的审批，task-approvals.mts）：由它等人、到时限答。
// 握手时声明 clientTools，命名空间取注册表里的，引擎挑执行方时挑得中这条连接。

import { prepareSpeed, type SpeedStore } from '../../protocol/src/codex-speeds.mjs'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import { NO_RECIPIENT_MESSAGE } from '../../shared/src/server-requests.mjs'
import type { InstructionStore } from './codex-instructions.mjs'
import { type DeviceTools, declareDeviceTools } from './device-tools.mjs'
import type { UpstreamDialect } from './dialect.mjs'
import { NATIVE_CODEX_DIALECT } from './native-codex.mjs'
import {
  type Connector,
  DeviceError,
  idKey,
  isObject,
  type RpcId,
  UpstreamRpcError,
  type Wire,
} from './wire.mjs'

export interface EngineLink {
  readonly harness: string
  /** 握手之后取到的声明（runtime/info 的形状）。拿不到是 null */
  readonly runtime: Record<string, unknown> | null
  /** 对面是原生 codex（不认识我们的扩展键，threadSource 之类只有它认） */
  readonly native: boolean
  /** 断了、关了 */
  readonly closed: boolean
  /**
   * 发一个请求等应答。上游回了错误时抛 UpstreamRpcError；超时、断开抛普通的 Error。
   * timeoutMs 不给用开连接时定的默认时限
   */
  request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<any>
  /** 收通知；返回取消订阅 */
  onNotification(listener: (method: string, params: any) => void): () => void
  /** 对面发来、要答复的请求（设备工具的调用除外）：只给看，不由订阅者答（claimRequests 之后由调用方答）。返回取消订阅 */
  onServerRequest(listener: (method: string, params: any, id: RpcId) => void): () => void
  /**
   * 挑出由调用方自己答的请求（定时任务的审批时限，task-approvals.mts）：match 说是的，不再替引擎回“没人可送”，
   * 调用方要负责它有答复。收到请求时先问 onServerRequest 的订阅者、再问 match。只认最后给的一个
   */
  claimRequests(match: (method: string, params: any) => boolean): void
  /** 答一条对面发来的请求。连接断了返回 false */
  answer(id: RpcId, result: unknown): boolean
  /** 连接断了（引擎退出、设备进程关、自己关）。已经断了的当场调用。返回取消订阅 */
  onClose(listener: (reason: string) => void): () => void
  close(): void
}

/**
 * 开不了内部连接：harness 没配（unknownHarness）、没在跑、连不上（harnessUnavailable）。
 * 是 DeviceError，经客户端的请求抛出去时带着设备层的错误码
 */
export class EngineUnavailable extends DeviceError {
  constructor(
    harness: string,
    message: string,
    reason: 'harnessUnavailable' | 'unknownHarness' = 'harnessUnavailable',
  ) {
    super(reason, message, { harness })
  }
}

/** 没人可送时一直等着（等有连接订阅会话再送）的引擎。原生 codex 也是，另按方言认 */
const WAITING_ENGINES = new Set(['claude-code'])

/** 没有客户端拿着的请求，先等这么久再看（毫秒）：引擎一口气发给各条连接，各走各的套接字，前后差几毫秒 */
const HELD_GRACE_MS = 300
/** 有客户端拿着的，隔这么久再看一眼它还在不在（毫秒） */
const HELD_RECHECK_MS = 5_000

export interface EngineLinkOptions {
  harness: string
  connect: Connector
  dialect: UpstreamDialect
  version: string
  handshakeTimeoutMs: number
  /** request 不给时限时用的 */
  requestTimeoutMs: number
  tools: Pick<DeviceTools, 'namespaces' | 'has' | 'dispatch' | 'turnEnded'>
  /** 这个 harness 发来的这条请求（按请求号）此刻有没有真正的客户端连接拿着 */
  held(harness: string, requestId: RpcId): boolean
  heldGraceMs?: number
  heldRecheckMs?: number
  /** 原生 codex 的开发者指令按会话记在哪（codex-instructions.mts）。不给就不补 */
  instructions?: InstructionStore
  /** 原生 codex 的速度按会话记在哪（codex-speeds.mts）。不给就不记不补 */
  speeds?: SpeedStore
  log?(line: string): void
}

interface Waiting {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export async function connectEngineLink(options: EngineLinkOptions): Promise<EngineLink> {
  const { dialect, harness, tools } = options
  const waiting = new Map<number, Waiting>()
  const notified = new Set<(method: string, params: any) => void>()
  const requested = new Set<(method: string, params: any, id: RpcId) => void>()
  const closing = new Set<(reason: string) => void>()
  /** 替引擎看着的请求（没答的审批、提问……），键是请求号 */
  const unanswered = new Map<string, NodeJS.Timeout>()
  let sequence = 0
  let claims: ((method: string, params: any) => boolean) | null = null
  let closedWith: string | null = null
  let runtime: Record<string, unknown> | null = null
  let wire: Wire | null = null

  const send = (frame: unknown) => {
    if (closedWith === null) wire?.send(JSON.stringify(frame))
  }
  const shut = (reason: string) => {
    if (closedWith !== null) return false
    closedWith = reason
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    waiting.clear()
    for (const timer of unanswered.values()) clearTimeout(timer)
    unanswered.clear()
    for (const listener of [...closing]) listener(reason)
    return true
  }
  // 没人可送就当场失败的引擎：握手之后才知道是哪种。原生 codex、报不出引擎名的照原样不答
  const failsUnheld = () =>
    !dialect.clientToolsByDevice &&
    typeof runtime?.engine === 'string' &&
    !WAITING_ENGINES.has(runtime.engine)
  const watchRequest = (id: RpcId) => {
    const key = idKey(id)
    const check = () => {
      if (closedWith !== null || !unanswered.has(key)) return
      if (options.held(harness, id)) {
        unanswered.set(key, later(check, options.heldRecheckMs ?? HELD_RECHECK_MS))
        return
      }
      unanswered.delete(key)
      send({ id, error: { code: -32000, message: NO_RECIPIENT_MESSAGE } })
    }
    unanswered.set(key, later(check, options.heldGraceMs ?? HELD_GRACE_MS))
  }

  const receive = (raw: string) => {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (!isObject(frame)) return
    if (typeof frame.method === 'string') {
      const params = isObject(frame.params) ? frame.params : {}
      if (frame.id == null) {
        if (frame.method === 'serverRequest/resolved' && params.requestId != null) {
          const key = idKey(params.requestId as RpcId)
          clearTimeout(unanswered.get(key))
          unanswered.delete(key)
        }
        // 回合结束：这个回合里还在执行的设备工具作废
        if (frame.method === 'turn/completed' && isObject(params.turn))
          tools.turnEnded(harness, String(params.turn.id))
        for (const listener of [...notified]) listener(frame.method, params)
        return
      }
      const id = frame.id as RpcId
      if (frame.method === 'item/tool/call' && tools.has(params.namespace)) {
        tools.dispatch(harness, params, (result) => {
          if (closedWith !== null) return false
          send({ id, result })
          return true
        })
        return
      }
      for (const listener of [...requested]) listener(frame.method, params, id)
      if (!claims?.(frame.method, params) && failsUnheld()) watchRequest(id)
      return
    }
    const entry = typeof frame.id === 'number' ? waiting.get(frame.id) : undefined
    if (!entry || typeof frame.id !== 'number') return
    waiting.delete(frame.id)
    clearTimeout(entry.timer)
    const error = frame.error
    if (isObject(error))
      entry.reject(
        new UpstreamRpcError({
          code: typeof error.code === 'number' ? error.code : -32603,
          message: typeof error.message === 'string' ? error.message : '上游回了一个错误',
          data: error.data,
        }),
      )
    else entry.resolve(frame.result)
  }

  try {
    wire = await options.connect({ message: receive, close: () => shut('连接断开了') })
  } catch (error) {
    throw new EngineUnavailable(harness, `could not connect to ${harness}: ${message(error)}`)
  }
  const opened = wire
  const call = (method: string, params: unknown, timeoutMs: number): Promise<any> =>
    new Promise((resolve, reject) => {
      if (closedWith !== null) {
        reject(new Error(closedWith))
        return
      }
      const id = ++sequence
      const timer = later(() => {
        waiting.delete(id)
        reject(new Error(`${method} 等了 ${timeoutMs} 毫秒没有应答`))
      }, timeoutMs)
      waiting.set(id, { resolve, reject, timer })
      opened.send(JSON.stringify({ id, method, params }))
    })
  const close = () => {
    if (shut('连接已经关了')) opened.close()
  }
  try {
    const greeting = dialect.initializeParams(
      declareDeviceTools(
        {
          clientInfo: { name: 'litch-device', title: null, version: options.version },
          // 项目、队列那几组方法在上游协议里标着实验性。声明 backgroundTasks：引擎的后台任务集合也发给这条连接，
          // 没有客户端连着时会话树、定时任务的回报照样数得出后台任务（原生 codex 的方言不带我们的键）
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            [EXTENSIONS_CAPABILITY]: [EXTENSION.backgroundTasks],
          },
        },
        tools.namespaces(),
      ),
    )
    const init = await call('initialize', greeting, options.handshakeTimeoutMs)
    opened.send(JSON.stringify({ method: 'initialized' }))
    runtime = await dialect.describe(init, (method, params) =>
      call(method, params, options.handshakeTimeoutMs),
    )
  } catch (error) {
    close()
    throw new EngineUnavailable(harness, `could not connect to ${harness}: ${message(error)}`)
  }
  return {
    harness,
    runtime,
    native: dialect.clientToolsByDevice === true,
    get closed() {
      return closedWith !== null
    },
    async request(method, params, requestOptions) {
      const timeoutMs = requestOptions?.timeoutMs ?? options.requestTimeoutMs
      // 原生 codex 不保存速度：带了的记下来，恢复、分叉没带时补回（codex-speeds.mts）
      const sped =
        isObject(params) && options.speeds && dialect === NATIVE_CODEX_DIALECT
          ? prepareSpeed(method, params, options.speeds)
          : null
      if (sped) params = sped.params
      const send = async (ready: unknown) => {
        const result = await call(
          method,
          (isObject(ready) ? dialect.outgoing(method, ready) : null) ?? ready,
          timeoutMs,
        )
        sped?.remember(result)
        return result
      }
      // 原生 codex 建会话、恢复、分叉：先补齐开发者指令（codex-instructions.mts）
      const prepared =
        isObject(params) && options.instructions
          ? dialect.instructions?.(method, params, {
              ask: (asked, given) => call(asked, given, options.handshakeTimeoutMs),
              store: options.instructions,
              log: options.log ?? (() => {}),
            })
          : null
      if (!prepared) return send(params)
      const { params: ready, remember } = await prepared
      const result = await send(ready)
      remember(result)
      return result
    },
    onNotification(listener) {
      notified.add(listener)
      return () => notified.delete(listener)
    },
    onServerRequest(listener) {
      requested.add(listener)
      return () => requested.delete(listener)
    },
    claimRequests(match) {
      claims = match
    },
    answer(id, result) {
      if (closedWith !== null) return false
      const key = idKey(id)
      clearTimeout(unanswered.get(key))
      unanswered.delete(key)
      send({ id, result })
      return true
    },
    onClose(listener) {
      if (closedWith !== null) {
        listener(closedWith)
        return () => {}
      }
      closing.add(listener)
      return () => closing.delete(listener)
    },
    close,
  }
}

function later(run: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(run, Math.max(0, ms))
  timer.unref()
  return timer
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ---------- 发一个回合、等它结束 ----------

export interface TurnResult {
  turnId: string
  status: 'completed' | 'failed' | 'interrupted' | 'timedOut'
  /** 回合里最后一条完整的回答 */
  lastMessage: string | null
  /** 失败时引擎给的说明、超时时我们的说明 */
  error: string | null
}

export interface TurnOptions {
  /** 最长等多久，到点打断，记 timedOut */
  timeoutMs: number
  /** 中止：不再等，抛出 signal.reason。回合留在引擎里接着跑，不替它打断 */
  signal?: AbortSignal
  /** turn/start 应答到了（回合有了标识） */
  onStarted?(turnId: string): void
  /** 打断之后再等回合结束多久（毫秒），默认 30 秒 */
  interruptGraceMs?: number
}

/**
 * 发一个回合并等它结束：turn/start，按 turnId 认 turn/completed，收集最后一条回答。
 * 连接断了抛错（回合可能还在引擎里跑）
 */
export async function runTurn(
  link: EngineLink,
  params: { threadId: string; input: unknown[]; overrides?: Record<string, unknown> },
  options: TurnOptions,
): Promise<TurnResult> {
  // 条目和结束的通知都可能比 turn/start 的应答先到：先订阅，攒着
  const watch = watchTurn(link, params.threadId)
  try {
    const started = await link.request('turn/start', {
      ...params.overrides,
      threadId: params.threadId,
      input: params.input,
    })
    const turn = isObject(started) && isObject(started.turn) ? started.turn : null
    if (typeof turn?.id !== 'string') throw new Error(`${link.harness} did not start the turn`)
    options.onStarted?.(turn.id)
    return await watch.follow(turn.id, options)
  } finally {
    watch.dispose()
  }
}

export interface TurnWatch {
  /** 等这个回合结束（它可能已经结束了，通知攒着） */
  follow(turnId: string, options: TurnOptions): Promise<TurnResult>
  dispose(): void
}

/**
 * 盯着一个会话的回合：订阅之后再恢复会话、发回合，中间到的通知不会漏。
 * 设备进程重启后接着等上次的回合也用它（先订阅，再 thread/resume，再 follow）
 */
export function watchTurn(link: EngineLink, threadId: string): TurnWatch {
  const answers = new Map<string, string>()
  const ended = new Map<string, Record<string, unknown>>()
  const wakers = new Set<() => void>()
  const stop = link.onNotification((method, params) => {
    if (!isObject(params) || params.threadId !== threadId) return
    if (method === 'item/completed') {
      const item = isObject(params.item) ? params.item : null
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())
        answers.set(String(params.turnId ?? ''), item.text)
    } else if (method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : null
      if (typeof turn?.id !== 'string') return
      ended.set(turn.id, turn)
      for (const wake of [...wakers]) wake()
    }
  })

  /** 等到回合结束（给出 turn 对象）或到点（null）。连接断了、中止了抛错 */
  const until = (turnId: string, ms: number, signal?: AbortSignal) =>
    new Promise<Record<string, unknown> | null>((resolve, reject) => {
      const done = ended.get(turnId)
      if (done) {
        resolve(done)
        return
      }
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      const cleanup = () => {
        clearTimeout(timer)
        wakers.delete(wake)
        unclose()
        signal?.removeEventListener('abort', abort)
      }
      const wake = () => {
        const turn = ended.get(turnId)
        if (!turn) return
        cleanup()
        resolve(turn)
      }
      const abort = () => {
        cleanup()
        reject(signal?.reason)
      }
      const timer = later(() => {
        cleanup()
        resolve(null)
      }, ms)
      wakers.add(wake)
      signal?.addEventListener('abort', abort, { once: true })
      const unclose = link.onClose((reason) => {
        cleanup()
        reject(new Error(`the connection to ${link.harness} was lost: ${reason}`))
      })
    })

  /** 通知里没见到回答（比如条目早于订阅就结束了）：读一遍会话 */
  const readAnswer = async (turnId: string): Promise<string | null> => {
    const read = await link
      .request('thread/read', { threadId, includeTurns: true })
      .catch(() => null)
    const thread = isObject(read) && isObject(read.thread) ? read.thread : null
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const turn = turns.find((item) => isObject(item) && item.id === turnId)
    return isObject(turn) ? lastAnswerIn(turn) : null
  }

  return {
    async follow(turnId, options) {
      const turn = await until(turnId, options.timeoutMs, options.signal)
      if (turn) return turnResult(turn, answers.get(turnId) ?? (await readAnswer(turnId)))
      await link.request('turn/interrupt', { threadId, turnId }).catch(() => null)
      const after = await until(turnId, options.interruptGraceMs ?? 30_000, options.signal).catch(
        () => null,
      )
      return {
        turnId,
        status: 'timedOut',
        lastMessage: after ? (answers.get(turnId) ?? null) : null,
        error: `the turn ran longer than ${Math.round(options.timeoutMs / 60000)} minutes and was interrupted`,
      }
    },
    dispose: stop,
  }
}

/** 一个回合里最后一条回答（thread/read 读出来的 turn 对象） */
export function lastAnswerIn(turn: Record<string, unknown>): string | null {
  const items = Array.isArray(turn.items) ? turn.items : []
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]
    if (isObject(item) && item.type === 'agentMessage' && typeof item.text === 'string')
      if (item.text.trim()) return item.text
  }
  return null
}

/** 结束了的 turn 对象换成 TurnResult */
export function turnResult(turn: Record<string, unknown>, lastMessage: string | null): TurnResult {
  const status =
    turn.status === 'completed' || turn.status === 'interrupted' ? turn.status : 'failed'
  const error =
    isObject(turn.error) && typeof turn.error.message === 'string' ? turn.error.message : null
  return { turnId: String(turn.id), status, lastMessage, error: error || null }
}
