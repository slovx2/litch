import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { HarnessDeclaration } from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { declaredExtensions } from '../../shared/src/harness-declaration.mjs'
import { applyNotificationOptOut } from '../../shared/src/notification-opt-out.mjs'
import { ProtocolError, pageRecords } from '../../shared/src/protocol-contract.mjs'
import {
  CODEX_PROTOCOL_VERSION,
  codexUserAgent,
  platformFamily,
  platformOs,
} from '../../shared/src/runtime-version.mjs'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { type Backend, loadAcp } from './backend-loader.mjs'
import { declaration } from './declaration.mjs'
import {
  type BackendId,
  decodeThread,
  encodeThread,
  rewriteThreads,
  threadReferences,
} from './id-space.mjs'
import { RouterSettings } from './router-settings.mjs'
import { AntigravityServer } from './server.mjs'

interface Connection {
  peer: RpcPeer
  initializing: Promise<any>
}
interface Pending {
  backend: BackendId
  peerId: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}
export interface RouterOptions {
  env?: NodeJS.ProcessEnv
  sdk?: Backend
  acp?: () => Promise<Backend>
}
const blankConfig = { groups: [], settings: [], values: {}, actions: [], version: '', files: [] }
const capabilityKeys = [
  'displayName',
  'badge',
  'extensions',
  'features',
  'permissionPresets',
] as const
export class AntigravityRouter implements Backend {
  readonly settings: RouterSettings
  private readonly options: RouterOptions
  private sdk: Backend | undefined
  private acp: Promise<Backend> | undefined
  private readonly peers = new Map<
    string,
    { peer: RpcPeer; initialize: any; extensions: Set<string> }
  >()
  private readonly connections = new Map<string, Connection>()
  private readonly pending = new Map<string, Pending>()
  private readonly requests = new Map<
    string,
    { backend: BackendId; id: string | number | null; holders: Set<string> }
  >()
  private readonly declarations = new Map<BackendId, HarnessDeclaration>([['sdk', declaration]])
  private closed = false
  constructor(home: string, options: RouterOptions = {}) {
    this.settings = new RouterSettings(home)
    this.options = options
    this.sdk = options.sdk
  }
  private backend(id: BackendId): Promise<Backend> {
    if (id === 'sdk') {
      this.sdk ??= new AntigravityServer(join(this.settings.home, 'sdk'), {
        env: this.options.env ?? process.env,
      })
      return Promise.resolve(this.sdk)
    }
    this.acp ??= (
      this.options.acp?.() ?? loadAcp(this.settings.home, this.options.env ?? process.env)
    ).catch(() => {
      this.acp = undefined
      throw new ProtocolError(
        -32004,
        '官方 Antigravity ACP 后端不可用；请安装支持 agy 的 Litch 版本并配置 agy CLI',
      )
    })
    return this.acp
  }
  private requestId(backend: BackendId, id: unknown): string {
    return `agy:${backend}:request:${Buffer.from(JSON.stringify(id)).toString('base64url')}`
  }
  private receive(backend: BackendId, peer: RpcPeer, message: WireMessage): void {
    if (!('method' in message)) {
      const pending = this.pending.get(String(message.id))
      if (!pending || pending.peerId !== peer.id || pending.backend !== backend) return
      this.pending.delete(String(message.id))
      clearTimeout(pending.timer)
      if (message.error)
        pending.reject(new ProtocolError(message.error.code, message.error.message))
      else pending.resolve(message.result)
      return
    }
    const capable = this.peers.get(peer.id)?.extensions.has('threadCapabilities')
    let params: any = rewriteThreads(
      message.params,
      backend,
      true,
      capable ? this.declarations.get(backend) : undefined,
    )
    if ('id' in message) {
      const id = this.requestId(backend, message.id)
      const request = this.requests.get(id) ?? {
        backend,
        id: message.id,
        holders: new Set<string>(),
      }
      request.holders.add(peer.id)
      this.requests.set(id, request)
      peer.send({ ...message, id, params })
    } else {
      if (message.method === 'serverRequest/resolved') {
        const id = this.requestId(backend, params.requestId)
        this.requests.delete(id)
        params = { ...params, requestId: id }
      }
      peer.send({ ...message, params })
    }
  }
  private raw(
    backend: BackendId,
    server: Backend,
    peer: RpcPeer,
    method: string,
    params: any,
  ): Promise<any> {
    const id = `agy-router-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Antigravity 后端请求超时'))
      }, 150000)
      this.pending.set(id, { backend, peerId: peer.id, resolve, reject, timer })
      Promise.resolve(server.handle(peer, { id, method, params })).catch((error: Error) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }
  private async call(backend: BackendId, peer: RpcPeer, method: string, params: any): Promise<any> {
    const server = await this.backend(backend)
    const key = `${backend}:${peer.id}`
    let connection = this.connections.get(key)
    if (!connection) {
      const original = this.peers.get(peer.id)
      if (!original) throw new ProtocolError(-32002, '请先 initialize')
      const wrapped: RpcPeer = {
        id: peer.id,
        close: () => peer.close(),
        send: (message) => this.receive(backend, peer, message),
      }
      connection = { peer: wrapped, initializing: Promise.resolve() }
      this.connections.set(key, connection)
      connection.initializing = this.raw(
        backend,
        server,
        wrapped,
        'initialize',
        original.initialize,
      ).catch((error) => {
        this.connections.delete(key)
        throw error
      })
    }
    if (method === 'initialize') return connection.initializing
    await connection.initializing
    return this.raw(backend, server, connection.peer, method, params)
  }
  private async capabilities(backend: BackendId, peer: RpcPeer): Promise<HarnessDeclaration> {
    const info = await this.call(backend, peer, 'runtime/info', {})
    const value = Object.fromEntries(
      capabilityKeys.filter((key) => info[key] !== undefined).map((key) => [key, info[key]]),
    ) as HarnessDeclaration
    this.declarations.set(backend, value)
    return value
  }
  private async config(peer: RpcPeer): Promise<any> {
    try {
      return await this.call(this.settings.backend(), peer, 'litch/harness/config/read', {
        harness: 'agy',
      })
    } catch {
      return blankConfig
    }
  }
  private outbound(peer: RpcPeer, backend: BackendId, result: any, method: string): any {
    if (method === 'thread/loaded/list')
      return { ...result, data: result.data.map((id: string) => encodeThread(backend, id)) }
    return rewriteThreads(
      result,
      backend,
      true,
      this.peers.get(peer.id)?.extensions.has('threadCapabilities')
        ? this.declarations.get(backend)
        : undefined,
    )
  }
  async handle(peer: RpcPeer, message: WireMessage): Promise<void> {
    if (!('method' in message)) {
      const request = this.requests.get(String(message.id))
      if (!request?.holders.has(peer.id)) return
      const server = await this.backend(request.backend)
      const connection = this.connections.get(`${request.backend}:${peer.id}`)
      if (connection) await server.handle(connection.peer, { ...message, id: request.id })
      return
    }
    if (!('id' in message)) return
    try {
      if (this.closed) throw new Error('Antigravity 已停止')
      const result = await this.dispatch(peer, message.method, message.params ?? {})
      peer.send({ jsonrpc: '2.0', id: message.id, result })
    } catch (error) {
      peer.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: error instanceof ProtocolError ? error.code : -32000,
          message: error instanceof Error ? error.message : 'Antigravity 后端错误',
        },
      })
    }
  }
  private async dispatch(peer: RpcPeer, method: string, params: any): Promise<any> {
    if (method === 'initialize') {
      if (this.peers.has(peer.id)) throw new ProtocolError(-32600, '连接已经初始化')
      applyNotificationOptOut(peer, params)
      this.peers.set(peer.id, { peer, initialize: params, extensions: declaredExtensions(params) })
      // 外壳握手不加载任何后端，未配置 API key 和 SDK 时订阅用户仍能进入。
      return {
        userAgent: codexUserAgent(
          params.clientInfo?.name ?? 'codex-app',
          params.clientInfo?.version ?? 'unknown',
          CODEX_PROTOCOL_VERSION,
          'codex-harness-adapter-antigravity',
        ),
        codexHome: this.settings.home,
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    }
    if (!this.peers.has(peer.id)) throw new ProtocolError(-32002, '请先 initialize')
    if (method === 'litch/harness/config/read') return this.settings.read(await this.config(peer))
    if (method === 'litch/harness/config/write') {
      const inner = await this.config(peer)
      if (params.expectedVersion !== this.settings.version(inner.version))
        throw new ProtocolError(-32000, '配置已变化，请重新读取')
      if (!Array.isArray(params.edits)) throw new ProtocolError(-32602, 'edits 必须是数组')
      const mode = params.edits.filter((edit: any) => edit.key === 'authenticationMode')
      if (mode.length) {
        if (params.edits.length !== 1) throw new ProtocolError(-32602, '切换鉴权方式需单独保存')
        this.settings.write(mode[0].value)
        setImmediate(() => {
          for (const connection of this.peers.values())
            if (connection.extensions.has('harnessConfig'))
              connection.peer.send({
                method: 'litch/harness/config/changed',
                params: { harness: 'agy', part: 'config' },
              })
        })
        return {
          version: this.settings.version((await this.config(peer)).version),
          overriddenKeys: [],
          restartRequired: true,
        }
      }
      const result = await this.call(this.settings.backend(), peer, method, {
        ...params,
        expectedVersion: inner.version,
      })
      return { ...result, version: this.settings.version(result.version) }
    }
    if (method === 'thread/list' || method === 'thread/loaded/list')
      return this.list(peer, method, params)
    const refs = threadReferences(params).map(decodeThread)
    const backend = refs[0]?.backend ?? this.settings.backend()
    if (refs.some((ref) => ref.backend !== backend))
      throw new ProtocolError(-32602, '不能跨 Antigravity 后端操作会话')
    if (method === 'runtime/info') {
      const info = await this.call(backend, peer, method, params)
      return {
        ...info,
        ...HARNESS_IDENTITY.agy,
        engine: 'agy',
        extensions: [
          ...new Set([...(info.extensions ?? []), 'harnessConfig', 'threadCapabilities']),
        ],
      }
    }
    if (['thread/start', 'thread/read', 'thread/resume', 'thread/fork'].includes(method))
      await this.capabilities(backend, peer)
    const result = await this.call(backend, peer, method, rewriteThreads(params, backend, false))
    // ACP 建会话后可能才知道 mode/model；返回其最新声明。
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method))
      await this.capabilities(backend, peer)
    return this.outbound(peer, backend, result, method)
  }
  private async list(peer: RpcPeer, method: string, params: any): Promise<any> {
    const rows: any[] = []
    let succeeded = 0
    for (const backend of ['sdk', 'acp'] as const) {
      try {
        await this.capabilities(backend, peer)
        let cursor: string | null = null
        const seen = new Set<string>()
        do {
          const result = await this.call(backend, peer, method, {
            ...params,
            limit: 1000,
            cursor,
            sortDirection: 'asc',
          })
          rows.push(...this.outbound(peer, backend, result, method).data)
          cursor = result.nextCursor ?? null
          if (cursor && (seen.has(cursor) || seen.size > 100)) throw new Error('后端分页游标异常')
          if (cursor) seen.add(cursor)
        } while (cursor)
        succeeded++
      } catch {
        peer.send({
          method: 'warning',
          params: {
            message: `${backend === 'sdk' ? 'API key' : '官方 ACP'} 后端不可用，列表暂时不含其会话；未迁移或删除历史`,
          },
        })
      }
    }
    if (!succeeded) throw new Error('Antigravity 两个后端均无法读取会话列表')
    if (method === 'thread/loaded/list') return { data: rows, nextCursor: null }
    rows.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    return pageRecords(rows, params, 'agy:combined', (thread) => thread.id)
  }
  closePeer(peer: RpcPeer): void {
    this.peers.delete(peer.id)
    for (const backend of ['sdk', 'acp'] as const) {
      const key = `${backend}:${peer.id}`,
        connection = this.connections.get(key)
      if (connection) {
        this.connections.delete(key)
        void this.backend(backend).then((server) => server.closePeer(connection.peer))
      }
    }
    for (const [id, request] of this.requests) {
      request.holders.delete(peer.id)
      if (!request.holders.size) this.requests.delete(id)
    }
    for (const [id, pending] of this.pending)
      if (pending.peerId === peer.id) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(new Error('客户端已断开'))
      }
  }
  async close(): Promise<void> {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('引擎已停止'))
    }
    this.pending.clear()
    await Promise.all([
      this.sdk?.close(),
      this.acp?.then((backend) => backend.close()).catch(() => {}),
    ])
    this.connections.clear()
    this.peers.clear()
    this.requests.clear()
  }
}
