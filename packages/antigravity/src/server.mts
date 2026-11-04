import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { declaredExtensions } from '../../shared/src/harness-declaration.mjs'
import { applyNotificationOptOut } from '../../shared/src/notification-opt-out.mjs'
import {
  BROADCAST_THREAD_NOTIFICATIONS,
  ProtocolError,
} from '../../shared/src/protocol-contract.mjs'
import { ServerRequests } from '../../shared/src/server-requests.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { Configuration } from './config.mjs'
import { harnessConfig } from './harness-config.mjs'
import { ensureRuntime } from './install.mjs'
import { Projection } from './projection.mjs'
import { dispatch } from './protocol.mjs'
import { LocalHarness, type RuntimeOptions, type WireEvent } from './runtime.mjs'
import { envelope, Store, type Thread, type Turn } from './store.mjs'

interface Live {
  runtime: LocalHarness
  turn: Turn | null
  projection: Projection | null
  abort: AbortController
  interrupt: boolean
  failure: string | null
  timer?: NodeJS.Timeout
}
export interface ServerOptions {
  env?: NodeJS.ProcessEnv
  runtime?: (options: RuntimeOptions) => LocalHarness
  executable?: () => Promise<string>
}
export class AntigravityServer {
  readonly home: string
  readonly config: Configuration
  readonly store: Store
  readonly peers = new Map<string, RpcPeer>()
  readonly extensions = new Map<string, Set<string>>()
  readonly subscriptions = new Map<string, Set<string>>()
  readonly live = new Map<string, Live>()
  private readonly loading = new Map<string, Promise<Live>>()
  private readonly options: ServerOptions
  private readonly requests = new ServerRequests((id, method, params) =>
    this.notify(id, method, params),
  )
  private closed = false
  constructor(home: string, options: ServerOptions = {}) {
    this.home = home
    this.options = options
    this.config = new Configuration(home, options.env)
    this.store = new Store(home)
  }
  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if (!('method' in message)) {
      this.requests.answer(peer, message)
      return
    }
    if (!('id' in message)) return
    try {
      if (this.closed) throw new Error('引擎已关闭')
      if (message.method !== 'initialize' && !this.peers.has(peer.id))
        throw new ProtocolError(-32002, '请先 initialize')
      const result = await dispatch(this, peer, message.method, message.params ?? {})
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      peer.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: error instanceof ProtocolError ? error.code : -32000,
          message: error instanceof Error ? error.message : '引擎请求失败',
        },
      })
    }
  }
  initialize(peer: RpcPeer, params: any): void {
    this.peers.set(peer.id, peer)
    this.extensions.set(peer.id, declaredExtensions(params))
    applyNotificationOptOut(peer, params)
  }
  subscribe(peer: RpcPeer, id: string): void {
    const peers = this.subscriptions.get(id) ?? new Set<string>()
    peers.add(peer.id)
    this.subscriptions.set(id, peers)
    this.requests.replay((threadId) => this.targets(threadId))
  }
  targets(id: string): RpcPeer[] {
    return [...(this.subscriptions.get(id) ?? [])].flatMap((key) => this.peers.get(key) ?? [])
  }
  notify(id: string, method: string, params: any): void {
    const targets = BROADCAST_THREAD_NOTIFICATIONS.has(method)
      ? [...this.peers.values()]
      : this.targets(id)
    for (const peer of targets)
      peer.send({
        method,
        params: method === 'thread/started' ? params : { threadId: id, ...params },
      })
  }
  changed(): void {
    for (const peer of this.peers.values())
      if (this.extensions.get(peer.id)?.has('harnessConfig'))
        peer.send({
          method: 'litch/harness/config/changed',
          params: { harness: 'agy', part: 'config' },
        })
  }
  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    this.extensions.delete(peer.id)
    for (const subscribers of this.subscriptions.values()) subscribers.delete(peer.id)
    this.requests.dropPeer(peer.id, '客户端已断开')
  }
  async create(peer: RpcPeer, params: any): Promise<Thread> {
    this.checkSelection(params)
    const cwd = params.cwd ?? process.cwd()
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new ProtocolError(-32602, 'cwd 必须是存在的绝对目录')
    this.config.endpoint()
    const values = this.config.values()
    const now = Math.floor(Date.now() / 1000)
    const thread: Thread = {
      id: randomUUID(),
      cwd,
      model: params.model ?? values.model,
      baseUrl: values.baseUrl,
      instructions: [params.baseInstructions, params.developerInstructions]
        .filter((value) => typeof value === 'string')
        .join('\n\n'),
      createdAt: now,
      updatedAt: now,
      preview: '',
      turns: [],
    }
    await this.open(thread, false)
    this.store.save(thread)
    this.subscribe(peer, thread.id)
    setImmediate(() =>
      this.notify(thread.id, 'thread/started', { thread: envelope(thread, false) }),
    )
    return thread
  }
  checkSelection(params: any, thread?: Thread): void {
    if (params.permissions && params.permissions !== ':danger-full-access')
      throw new ProtocolError(-32602, '此实验入口仅支持逐次审批的完全访问模式')
    if (params.sandbox && params.sandbox !== 'danger-full-access')
      throw new ProtocolError(-32602, '此入口没有操作系统沙箱')
    if (params.approvalPolicy && params.approvalPolicy !== 'on-request')
      throw new ProtocolError(-32602, '此入口只支持逐次工具审批')
    if (params.collaborationMode?.mode && params.collaborationMode.mode !== 'default')
      throw new ProtocolError(-32602, '此入口尚不支持计划模式')
    if (
      params.model &&
      (typeof params.model !== 'string' || !/^[\w.:-]{1,150}$/.test(params.model))
    )
      throw new ProtocolError(-32602, '模型名无效')
    if (thread && params.model && params.model !== thread.model)
      throw new ProtocolError(-32602, '请新建会话以切换模型')
    if (params.ephemeral || params.dynamicTools?.length)
      throw new ProtocolError(-32602, '此入口尚不支持临时会话或客户端工具')
  }
  async open(thread: Thread, resume = true): Promise<Live> {
    const current = this.live.get(thread.id)
    if (current) return current
    const existing = this.loading.get(thread.id)
    if (existing) return existing
    const opening = (async () => {
      const endpoint = this.config.endpoint()
      const executable = await (this.options.executable?.() ??
        ensureRuntime(this.home, this.config.env.CHA_ANTIGRAVITY_CLI))
      const options: RuntimeOptions = {
        executable,
        home: this.home,
        config: harnessConfig(thread, endpoint, this.home, resume),
        event: (event) => this.event(thread, event),
        failed: (error) => this.failed(thread, error),
      }
      const runtime = this.options.runtime?.(options) ?? new LocalHarness(options)
      const live: Live = {
        runtime,
        turn: null,
        projection: null,
        abort: new AbortController(),
        interrupt: false,
        failure: null,
      }
      this.live.set(thread.id, live)
      try {
        const response = await runtime.start()
        if (this.closed || response.cascadeId !== thread.id)
          throw new Error('localharness 返回了错误的会话标识或引擎已关闭')
        return live
      } catch (error) {
        this.live.delete(thread.id)
        await runtime.close()
        throw error
      }
    })().finally(() => this.loading.delete(thread.id))
    this.loading.set(thread.id, opening)
    return opening
  }
  async start(peer: RpcPeer, params: any): Promise<Turn> {
    const thread = this.store.get(params.threadId)
    this.checkSelection(params, thread)
    if (
      !Array.isArray(params.input) ||
      !params.input.length ||
      params.input.some((item: any) => item.type !== 'text' || typeof item.text !== 'string')
    )
      throw new ProtocolError(-32602, '此入口只接受文字输入')
    const live = await this.open(thread)
    if (live.turn) throw new ProtocolError(-32600, '回合正在进行')
    this.subscribe(peer, thread.id)
    const turn: Turn = { id: randomUUID(), items: [], status: 'inProgress', error: null }
    live.turn = turn
    live.interrupt = false
    live.failure = null
    live.abort = new AbortController()
    live.projection = new Projection(turn, (method, p) =>
      this.notify(thread.id, method, { turnId: turn.id, ...p }),
    )
    thread.turns.push(turn)
    thread.preview ||= params.input
      .map((item: any) => item.text)
      .join('\n')
      .slice(0, 200)
    this.store.save(thread)
    setImmediate(() => {
      if (live.turn !== turn) return
      this.notify(thread.id, 'turn/started', { turn: { ...turn, items: [] } })
      if (live.interrupt) {
        this.finish(thread, 'interrupted')
        return
      }
      this.notify(thread.id, 'thread/status/changed', {
        status: { type: 'active', activeFlags: [] },
      })
      const item = {
        type: 'userMessage',
        id: randomUUID(),
        content: params.input.map((input: any) => ({
          type: 'text',
          text: input.text,
          text_elements: [],
        })),
      }
      live.projection?.add(item)
      live.projection?.done(item)
      try {
        live.runtime.send({
          userInput: { parts: params.input.map((input: any) => ({ text: input.text })) },
        })
      } catch (error) {
        this.failed(thread, error as Error)
      }
    })
    return { ...turn, items: [] }
  }
  private event(thread: Thread, event: WireEvent): void {
    const live = this.live.get(thread.id)
    if (!live?.turn) return
    if (event.policyDecisionRequest)
      void this.approve(thread, event.policyDecisionRequest).catch(() =>
        this.failed(thread, new Error('工具审批失败')),
      )
    if (event.stepUpdate) {
      const step = event.stepUpdate
      if (step.error?.httpCode === 401 || step.error?.httpCode === 403) {
        live.failure = 'Gemini API key 无效、已过期或无权访问此模型；请在账号设置中更新'
      }
      // 单个工具被拒绝也会 STATE_ERROR，模型仍可继续。只在根 trajectory 结束时收尾回合。
      live.projection?.step(step)
    }
    const state = event.trajectoryStateUpdate
    if (
      state &&
      !state.parentTrajectoryId &&
      (!state.trajectoryId || state.trajectoryId === thread.id)
    ) {
      if (['STATE_FULLY_IDLE', 'STATE_CANCELLED'].includes(state.state)) {
        this.finish(
          thread,
          live.interrupt || state.state === 'STATE_CANCELLED'
            ? 'interrupted'
            : state.error || live.failure
              ? 'failed'
              : 'completed',
          live.failure ??
            (state.error ? 'Gemini 请求失败；请检查 API key 是否有效及模型是否可用' : undefined),
        )
      }
    }
  }
  private async approve(thread: Thread, request: any): Promise<void> {
    const live = this.live.get(thread.id)
    if (!live?.turn || !live.projection || live.interrupt) return
    const turn = live.turn
    const item = live.projection.tool(request, thread)
    let decision: unknown = 'decline'
    try {
      this.notify(thread.id, 'thread/status/changed', {
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      })
      const file = item.type === 'fileChange'
      const response = await this.requests.send(
        this.targets(thread.id),
        thread.id,
        file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
        () => ({
          threadId: thread.id,
          turnId: turn.id,
          itemId: item.id,
          startedAtMs: Date.now(),
          reason: 'Antigravity 请求执行工具',
          ...(file
            ? { grantRoot: null }
            : {
                approvalId: item.id,
                command: item.command,
                cwd: item.cwd,
                commandActions: [],
                additionalPermissions: null,
                proposedExecpolicyAmendment: null,
                proposedNetworkPolicyAmendments: null,
                availableDecisions: ['accept', 'decline', 'cancel'],
              }),
        }),
        { signal: live.abort.signal, replayable: true },
      )
      decision = response?.decision
    } catch {
      decision = 'decline'
    }
    if (live.turn !== turn || live.abort.signal.aborted) return
    this.notify(thread.id, 'thread/status/changed', { status: { type: 'active', activeFlags: [] } })
    if (decision === 'cancel') {
      await this.interrupt(thread.id, turn.id)
      return
    }
    const accepted = decision === 'accept'
    if (!accepted) live.projection.deny(item)
    live.runtime.send({
      policyDecisionResponse: {
        requestId: request.requestId,
        outcome: accepted ? 'POLICY_EVALUATION_OUTCOME_ALLOW' : 'POLICY_EVALUATION_OUTCOME_DENY',
        denyReason: accepted ? '' : '用户拒绝或没有可处理审批的客户端',
      },
    })
  }
  async interrupt(id: string, turnId?: string): Promise<void> {
    const thread = this.store.get(id)
    const live = this.live.get(id)
    if (!live?.turn) return
    if (turnId && live.turn.id !== turnId) throw new ProtocolError(-32602, '回合标识不匹配')
    if (live.interrupt) return
    live.interrupt = true
    live.abort.abort()
    try {
      live.runtime.send({ haltRequest: true })
    } catch {
      /* 断开后同样走进程回收 */
    }
    live.timer = setTimeout(() => {
      void live.runtime.close().then(() => {
        this.finish(thread, 'interrupted')
        this.live.delete(id)
      })
    }, 1500)
  }
  private finish(thread: Thread, status: Turn['status'], message?: string): void {
    const live = this.live.get(thread.id)
    if (!live?.turn) return
    const turn = live.turn
    clearTimeout(live.timer)
    turn.status = status
    turn.error =
      status === 'failed'
        ? {
            message: message ?? 'localharness 执行失败',
            codexErrorInfo: null,
            additionalDetails: null,
          }
        : null
    live.abort.abort()
    live.projection?.finish()
    live.turn = null
    live.projection = null
    thread.updatedAt = Math.floor(Date.now() / 1000)
    this.store.save(thread)
    this.notify(thread.id, 'turn/completed', { turn })
    this.notify(thread.id, 'thread/status/changed', { status: { type: 'idle' } })
  }
  private failed(thread: Thread, error: Error): void {
    const live = this.live.get(thread.id)
    this.finish(thread, live?.interrupt ? 'interrupted' : 'failed', error.message)
    this.live.delete(thread.id)
    if (live) void live.runtime.close()
  }
  async close(): Promise<void> {
    this.closed = true
    for (const thread of this.store.threads.values()) this.finish(thread, 'failed', '引擎已停止')
    await Promise.all([...this.live.values()].map((live) => live.runtime.close()))
    await Promise.allSettled(this.loading.values())
    this.live.clear()
  }
}
