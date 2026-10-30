// 连接层的中间一层：一台设备的一条连接。
// 负责开传输、握手、断了之后按退避重连，并把状态变化报出去。连上之后的事（问设备信息、取目录）不归它管。
import {
  CLIENT_TOOLS_CAPABILITY,
  type ClientInfo,
  type ClientRequestMethod,
  type ClientRequests,
  type ClientToolsCapabilities,
  type ClientToolsDesktopInfo,
  type DeviceInitializeCapabilities,
  EXTENSION,
  type InitializeResponse,
  type JsonRpcId,
} from '../../../protocol/src/index.mjs'
import { type Cancel, createCancel } from '../channel/cancel.mjs'
import type { Clock } from '../channel/protocol.mjs'
import type { ConnectGuide, ConnectStage } from '../model.mjs'
import { phrase, type Text } from '../phrase.mjs'
import type { CoreTrace } from '../trace.mjs'
import type { ManagerRequests } from './manager-protocol.mjs'
import { createRpc, type Rpc, RpcAbortError, RpcError, type RpcRequestOptions } from './rpc.mjs'
import { ConnectError, type TransportOpener, toConnectError } from './transport.mjs'

export interface ConnectFailure {
  stage: ConnectStage
  /** 给人看的原因 */
  text: Text
  /** 对面原话的末尾，见 ConnectError */
  detail: string | null
  /** 该给哪一份“怎么办”，见 ConnectError。没有就不带这一项 */
  guide?: ConnectGuide
}

/**
 * 一条连接的状态。“探测中”“启动中”发生在开传输的过程里，这里统称 connecting，
 * 具体到了哪一步由开传输的那一方报上来，放在 step 里。
 */
export type LinkState =
  | { phase: 'idle' }
  | { phase: 'connecting'; attempt: number; step: Text | null }
  | { phase: 'handshaking'; attempt: number }
  | { phase: 'connected'; info: InitializeResponse }
  | { phase: 'waiting'; attempt: number; retryAt: number; failure: ConnectFailure }
  | { phase: 'failed'; failure: ConnectFailure }

export interface LinkOptions {
  open: TransportOpener
  clock: Clock
  clientInfo: ClientInfo
  /** 第 n 次失败后等多久再试。用完最后一个就一直用它 */
  backoffMs?: number[]
  handshakeTimeoutMs?: number
  requestTimeoutMs?: number
  state(state: LinkState): void
  notification(method: string, params: unknown): void
  /**
   * 这台桌面能执行的客户端工具命名空间（clientTools 扩展）。每次握手时现取；空的就不声明这项扩展。
   * 不给就是没有
   */
  clientTools?(): readonly string[]
  /**
   * 这台桌面端是哪台（主机名、名字），声明了 litch_machine 时随命名空间一起报，设备进程挑执行方、命令行写说明都用它。
   * 不给、或者返回 null 就不报
   */
  clientToolsDesktop?(): ClientToolsDesktopInfo | null
  /** 对面发来、要答复的请求。返回 undefined 表示不处理（会回“方法不存在”） */
  request?(method: string, params: unknown, id: JsonRpcId): Promise<unknown> | undefined
  log?(line: string): void
  /** 每个请求的摘要，交给这条连接上的 RPC（rpc.mts） */
  trace?: CoreTrace
}

export interface Link {
  readonly state: LinkState
  start(): void
  /** 正在等重连或已经失败时，立刻再试一次 */
  retry(): void
  /**
   * 连着的时候丢掉这条连接、从头再连一次。对面换了东西（比如装上了设备服务）之后用：
   * 对面是什么是开传输的那一方每次现认的，重新连一次就换过去了
   */
  reopen(): void
  stop(): void
  /** 暂时关闭连接并禁止重试；恢复不重开健康连接，也不销毁设备的缓存与订阅。 */
  setPaused(paused: boolean): void
  request<M extends ClientRequestMethod | keyof ManagerRequests>(
    method: M,
    params: (ClientRequests & ManagerRequests)[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<(ClientRequests & ManagerRequests)[M]['result']>
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10_000, 30_000]

export function createLink(options: LinkOptions): Link {
  const { clock } = options
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF
  let state: LinkState = { phase: 'idle' }
  let rpc: Rpc | null = null
  let handshaking: Rpc | null = null
  let opening: Cancel | null = null
  let stopTimer: (() => void) | null = null
  let paused = false
  let pausedFailure: Extract<LinkState, { phase: 'failed' }> | null = null
  // 每次尝试一个代号。异步步骤回来时代号对不上，说明这次尝试已经作废
  let epoch = 0

  const setState = (next: LinkState) => {
    state = next
    options.state(next)
  }

  const teardown = () => {
    epoch++
    stopTimer?.()
    stopTimer = null
    opening?.abort()
    opening = null
    const old = rpc
    rpc = null
    old?.close()
    handshaking?.close()
    handshaking = null
  }

  const fail = (attempt: number, failure: ConnectError) => {
    const shape: ConnectFailure = {
      stage: failure.stage,
      text: failure.text,
      detail: failure.detail,
      ...(failure.guide ? { guide: failure.guide } : {}),
    }
    if (!failure.retriable) {
      setState({ phase: 'failed', failure: shape })
      return
    }
    const delay = backoff[Math.min(attempt, backoff.length) - 1] ?? 1000
    setState({ phase: 'waiting', attempt, retryAt: clock.now() + delay, failure: shape })
    stopTimer = clock.setTimer(() => {
      stopTimer = null
      void connect(attempt + 1)
    }, delay)
  }

  const connect = async (attempt: number) => {
    const mine = ++epoch
    const stale = () => mine !== epoch
    setState({ phase: 'connecting', attempt, step: null })
    const cancel = createCancel()
    opening = cancel
    try {
      const transport = await options.open(cancel.signal, (step) => {
        if (!stale() && state.phase === 'connecting') {
          setState({ phase: 'connecting', attempt, step })
        }
      })
      if (stale()) {
        transport.close()
        return
      }
      opening = null
      setState({ phase: 'handshaking', attempt })
      const peer = createRpc(transport, {
        clock,
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        notification: (method, params) => {
          if (rpc === peer) options.notification(method, params)
        },
        request: (method, params, id) =>
          rpc === peer ? options.request?.(method, params, id) : undefined,
        close: (reason) => {
          // 只关心“当前这条、已经连上”的断开；握手期间的断开由下面的 catch 处理
          if (rpc !== peer || stale()) return
          rpc = null
          fail(1, new ConnectError('unreachable', reason ?? phrase('connect.dropped')))
        },
        ...(options.log ? { log: options.log } : {}),
        ...(options.trace ? { trace: options.trace } : {}),
      })
      let info: InitializeResponse
      handshaking = peer
      // 能执行的客户端工具：声明了扩展，还要在 litchClientTools 里列出命名空间（client-tools.mts）
      const tools = [...(options.clientTools?.() ?? [])]
      const desktop = tools.length > 0 ? (options.clientToolsDesktop?.() ?? null) : null
      try {
        info = (await peer.request(
          'initialize',
          {
            clientInfo: options.clientInfo,
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              // 我们认识的协议扩展。设备服务的聚合面要求声明了 harness 才让连；
              // 原生 codex 和适配器的单个入口不认识这个键，会忽略它：扩展只增不改，没声明的连接看到的是标准协议
              // deviceSettings：声明了才收得到设置变化的通知、不可用原因的两种语言版本
              // deviceProcesses：声明了，起进程时的扩展参数才生效，才收得到设备上终端增减的通知
              litchExtensions: [
                EXTENSION.filePreview,
                EXTENSION.harness,
                // deviceWorkspaces：声明了才收得到置顶、分区变化的通知
                EXTENSION.deviceWorkspaces,
                EXTENSION.declineWithNote,
                EXTENSION.deviceSettings,
                EXTENSION.deviceProcesses,
                // deviceService：声明了，runtime/info 的 device.service 里才有“在跑的是哪一份服务”
                EXTENSION.deviceService,
                EXTENSION.devicePower,
                // planConfirmation：声明了，Claude Code 和 Pi 的引擎在交计划时自己在回合里问要不要执行，
                // 界面不再问（plan-ask.ts）；不声明的话它们和原生 codex 一样回合带着计划结束，由客户端来问
                EXTENSION.planConfirmation,
                // deviceTasks：声明了才收得到定时任务和运行的变化通知（litch/task/changed、litch/task/run/changed）
                EXTENSION.deviceTasks,
                EXTENSION.manager,
                // sessionTree：声明了，会话对象上才有 Litch 子会话的 litchLineage，才收得到父子关系、提案变了的通知
                EXTENSION.sessionTree,
                // devicePairing：声明了才收得到配对状态和已绑定手机的变化通知（litch/pair/changed、litch/pair/phones/changed）
                EXTENSION.devicePairing,
                // clientApprovals：声明了才能把登录卡片挂到设备上、收到手机的答复（桌面端），收得到卡片变化的通知（手机）
                EXTENSION.clientApprovals,
                // harnessInstall：声明了才收得到安装任务的进度通知（litch/device/harness/install/changed）
                EXTENSION.harnessInstall,
                // nativeLineage：声明了，别的应用（Claude 桌面端）派出来的原生会话上才有 litchNativeLineage，
                // 侧栏据此默认收起它们
                EXTENSION.nativeLineage,
                // nativeOwner：声明了，导进来的会话被本机另一个进程占着时会话对象上带 litchNativeOwner、
                // 占用变了收得到通知，输入框据此置灰
                EXTENSION.nativeOwner,
                // worktrees：声明了，thread/start 的 litchWorktree 才生效，会话对象上才有 litchWorktree，
                // 才收得到工作树变了的通知（litch/worktree/changed）
                EXTENSION.worktrees,
                // peerMessages：声明了，别的会话发来的消息（Claude 的本机收件箱）在用户消息条目上带 litchPeer，
                // 对话里画成“来自 X 的消息”
                EXTENSION.peerMessages,
                // harnessConfig：声明了才收得到 harness 详情设置的变化和登录进展的通知
                // （litch/harness/config/changed、litch/harness/auth/updated）
                EXTENSION.harnessConfig,
                // backgroundTasks：声明了，会话对象上才有后台任务的集合 litchBackground、回合上才有来历 litchOrigin，
                // 才收得到集合变了的通知（litch/thread/background/changed）
                EXTENSION.backgroundTasks,
                // apiRetry：声明了才收得到模型请求重试的通知（litch/turn/apiRetry/updated），回合状态行写“重试中”
                EXTENSION.apiRetry,
                EXTENSION.turnRecovery,
                EXTENSION.harnessRuntime,
                // clientTools：litch_ 开头的命名空间的工具调用交给声明了的连接执行（内置浏览器、Computer Use）
                ...(tools.length > 0 ? [EXTENSION.clientTools] : []),
              ],
              ...(tools.length > 0
                ? {
                    [CLIENT_TOOLS_CAPABILITY]: {
                      namespaces: tools,
                      ...(tools.includes('litch_computer') ? { computerActions: true } : {}),
                      ...(desktop ? { desktop: { ...desktop } } : {}),
                    },
                  }
                : {}),
            } satisfies DeviceInitializeCapabilities & ClientToolsCapabilities,
          },
          { timeoutMs: options.handshakeTimeoutMs ?? 10_000 },
        )) as InitializeResponse
      } catch (error) {
        if (handshaking === peer) handshaking = null
        peer.close()
        if (stale()) return
        // 对面明确拒绝了握手，再试也是一样的结果；超时和断开可以再试
        const refused = error instanceof RpcError
        const message = error instanceof Error ? error.message : String(error)
        throw new ConnectError(
          'handshake',
          phrase('connect.handshakeFailed', { message }),
          !refused,
        )
      }
      if (stale()) {
        peer.close()
        return
      }
      peer.notify('initialized')
      handshaking = null
      rpc = peer
      setState({ phase: 'connected', info })
    } catch (error) {
      if (stale()) return
      opening = null
      fail(attempt, toConnectError(error))
    }
  }

  return {
    get state() {
      return state
    },

    start() {
      if (paused || state.phase !== 'idle') return
      void connect(1)
    },

    retry() {
      if (paused) return
      if (state.phase !== 'waiting' && state.phase !== 'failed') return
      teardown()
      void connect(1)
    },

    reopen() {
      if (paused) return
      if (state.phase !== 'connected') return
      teardown()
      void connect(1)
    },

    stop() {
      teardown()
      pausedFailure = null
      setState({ phase: 'idle' })
    },

    setPaused(next) {
      if (next === paused) return
      paused = next
      if (paused) {
        pausedFailure = state.phase === 'failed' ? state : null
        teardown()
        setState({ phase: 'idle' })
      } else if (pausedFailure) {
        const failure = pausedFailure
        pausedFailure = null
        setState(failure)
      } else {
        void connect(1)
      }
    },

    request(method, params, requestOptions) {
      if (!rpc) return Promise.reject(new RpcAbortError('closed', '设备未连接'))
      return rpc.request(method, params, requestOptions) as Promise<never>
    },
  }
}
