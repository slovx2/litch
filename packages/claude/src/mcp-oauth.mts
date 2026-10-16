import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  OAuthLoginRequired,
  oauthFetch,
  StoredOAuthProvider,
  validateOAuthDiscovery,
} from './mcp-oauth-provider.mjs'
import {
  type OAuthBinding,
  type OAuthCredential,
  OAuthCredentialStore,
  oauthBinding,
} from './mcp-oauth-store.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import { adapterHome } from './util.mjs'

interface PendingOAuth {
  peerId: string
  server: Server
  abort: AbortController
  timer?: NodeJS.Timeout
  used: boolean
  finish(success: boolean, error?: string): void
}
type Completion = (result: {
  name: string
  success: boolean
  error: string | null
  threadId: string | null
}) => void

// 同进程的管理 RPC 和真实 SDK 工具共用刷新锁，生命周期由适配器 server 管理。
export class McpOAuthManager {
  private readonly store: OAuthCredentialStore
  private readonly pending = new Map<string, PendingOAuth>()
  private readonly refreshing = new Map<string, Promise<OAuthCredential>>()
  closed = false

  constructor(home: string) {
    this.store = new OAuthCredentialStore(home)
  }

  async login(
    source: string,
    config: Record<string, unknown>,
    params: Record<string, unknown>,
    peerId: string,
    complete: Completion,
  ): Promise<{ authorizationUrl: string }> {
    if (this.closed) throw new ProtocolError(-32009, 'OAuth 管理器已关闭')
    const { name, scopes, timeoutSecs = 300 } = params
    if (
      typeof name !== 'string' ||
      !name ||
      (scopes != null &&
        (!Array.isArray(scopes) ||
          scopes.some((s) => typeof s !== 'string' || !s || /[\s\x00-\x1f]/.test(s)))) ||
      (timeoutSecs != null &&
        (typeof timeoutSecs !== 'number' ||
          !Number.isSafeInteger(timeoutSecs) ||
          timeoutSecs < 1 ||
          timeoutSecs > 3600))
    )
      throw new ProtocolError(-32602, 'OAuth 登录参数无效')
    if (!['http', 'sse'].includes(String(config.type)) || typeof config.url !== 'string')
      throw new ProtocolError(-32602, 'OAuth 登录只支持 HTTP 或 SSE MCP')
    if (
      Object.keys((config.headers as object | undefined) ?? {}).some(
        (k) => k.toLowerCase() === 'authorization',
      )
    )
      throw new ProtocolError(-32602, '显式 Bearer 凭据不能同时使用 OAuth')
    const binding = oauthBinding(source, name, config)
    const key = this.store.key(binding)
    if (this.pending.has(key) || this.refreshing.has(key))
      throw new ProtocolError(-32009, '该 MCP 服务正在授权或刷新')
    const abort = new AbortController()
    const state = randomBytes(32).toString('base64url')
    const path = '/oauth/callback/' + randomBytes(24).toString('base64url')
    let provider: StoredOAuthProvider | undefined
    const pending: PendingOAuth = {
      peerId,
      abort,
      used: false,
      server: createServer(),
      finish: () => {},
    }
    pending.finish = (success, error) => {
      if (!this.pending.delete(key)) return
      clearTimeout(pending.timer)
      abort.abort()
      pending.server.close()
      pending.server.closeIdleConnections()
      complete({
        name,
        success,
        error: error ?? null,
        threadId: typeof params.threadId === 'string' ? params.threadId : null,
      })
    }
    this.pending.set(key, pending)
    pending.timer = setTimeout(
      () => pending.finish(false, 'OAuth 登录已超时'),
      ((timeoutSecs ?? 300) as number) * 1000,
    )
    pending.timer.unref()
    pending.server.on('request', async (request, response) => {
      let ownsFlow = false
      const disconnected = () => {
        // 正常 res.end 之后也会 close，只有提前断开才撤销本次授权。
        if (ownsFlow && !response.writableEnded) pending.finish(false, 'OAuth 回调连接已断开')
      }
      response.once('close', disconnected)
      // FIN/RST 读到后 response close 还要晚一轮事件循环；只等 close 会在这期间接受迟到 token。
      request.socket.once('end', disconnected).once('error', disconnected)
      const respond = (status: number, message: string) =>
        response
          .writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            Connection: 'close',
          })
          .end(message)
      try {
        if (request.method !== 'GET' || !provider || (request.url?.length ?? 0) > 8192)
          return void respond(400, '无效的授权回调')
        const url = new URL(request.url ?? '/', provider.redirectUrl)
        const expectedHost = new URL(provider.redirectUrl).host
        const received = Buffer.from(url.searchParams.get('state') ?? '')
        const expected = Buffer.from(state)
        if (
          request.headers.host !== expectedHost ||
          url.pathname !== path ||
          url.searchParams.getAll('state').length !== 1 ||
          received.length !== expected.length ||
          !timingSafeEqual(received, expected) ||
          pending.used ||
          !this.pending.has(key)
        )
          return void respond(400, '授权状态无效或已经使用')
        pending.used = true
        ownsFlow = true
        if (url.searchParams.has('error')) {
          respond(400, '授权被拒绝')
          pending.finish(false, 'OAuth 授权被拒绝')
          return
        }
        const code = url.searchParams.get('code')
        if (!code || url.searchParams.getAll('code').length !== 1) {
          respond(400, '授权码无效')
          pending.finish(false, 'OAuth 授权码无效')
          return
        }
        if (
          (await auth(provider, {
            serverUrl: binding.url,
            authorizationCode: code,
            fetchFn: oauthFetch(abort.signal),
          })) !== 'AUTHORIZED'
        )
          throw new Error()
        // token 响应可能与回调断开同批到达；先让已到达的断开事件分发，再在唯一提交点复核。
        await new Promise<void>((resolve) => setImmediate(resolve))
        abort.signal.throwIfAborted()
        if (request.socket.destroyed) throw new Error()
        this.store.write(provider.record)
        respond(200, 'MCP 授权完成，可以关闭此页面。')
        pending.finish(true)
      } catch {
        respond(400, 'MCP 授权失败')
        pending.finish(false, 'OAuth 授权码交换或凭据保存失败')
      }
    })
    try {
      await new Promise<void>((resolve, reject) => {
        pending.server.once('error', reject)
        pending.server.listen(0, '127.0.0.1', resolve)
      })
      abort.signal.throwIfAborted()
      const address = pending.server.address()
      if (!address || typeof address === 'string') throw new Error()
      const redirect = `http://127.0.0.1:${address.port}${path}`
      const initial = this.store.read(binding)
      // 每次交互授权使用独立回调地址和注册，失败不覆盖已保存的旧会话。
      delete initial.tokens
      delete initial.expiresAt
      delete initial.client
      delete initial.discovery
      provider = new StoredOAuthProvider(initial, redirect, state, scopes as string[] | undefined)
      const result = await auth(provider, {
        serverUrl: binding.url,
        ...(Array.isArray(scopes) ? { scope: scopes.join(' ') } : {}),
        fetchFn: oauthFetch(abort.signal),
      })
      abort.signal.throwIfAborted()
      if (result !== 'REDIRECT' || !provider.authorizationUrl) throw new Error()
      return { authorizationUrl: provider.authorizationUrl }
    } catch {
      pending.finish(false, 'OAuth 发现或登录初始化失败')
      throw new ProtocolError(-32001, 'OAuth 发现或登录初始化失败')
    }
  }

  status(source: string, name: string, config: Record<string, unknown>): 'oAuth' | 'notLoggedIn' {
    return this.store.read(oauthBinding(source, name, config)).tokens ? 'oAuth' : 'notLoggedIn'
  }

  fetch(
    source: string,
    name: string,
    config: Record<string, unknown>,
    signal: AbortSignal,
  ): typeof fetch {
    const binding = oauthBinding(source, name, config)
    const origin = new URL(binding.url).origin
    const explicit = Object.keys((config.headers as object | undefined) ?? {}).some(
      (k) => k.toLowerCase() === 'authorization',
    )
    return async (input, init) => {
      if (this.closed) throw new Error('OAuth 运行时已关闭')
      const request = new Request(input, init)
      // SSE 的消息端点可以改变路径，但不能把当前服务的凭据带到其他 origin。
      if (new URL(request.url).origin !== origin) throw new Error('MCP 请求不能跨来源传递凭据')
      const combined = AbortSignal.any([signal, request.signal])
      let credential = explicit ? undefined : this.store.read(binding)
      if (
        credential?.tokens &&
        credential.expiresAt !== undefined &&
        credential.expiresAt <= Date.now() + 10_000
      )
        credential = await this.refresh(binding, credential.tokens.access_token)
      const send = async (value: OAuthCredential | undefined) => {
        const headers = new Headers(request.headers)
        if (value?.tokens) headers.set('Authorization', 'Bearer ' + value.tokens.access_token)
        return fetch(request.clone(), { headers, redirect: 'error', signal: combined })
      }
      let response = await send(credential)
      if (response.status === 401 && !explicit) {
        await response.body?.cancel()
        if (!credential?.tokens?.refresh_token) throw new OAuthLoginRequired()
        credential = await this.refresh(binding, credential.tokens.access_token)
        response = await send(credential)
        if (response.status === 401) {
          await response.body?.cancel()
          throw new OAuthLoginRequired()
        }
      }
      return response
    }
  }

  private async refresh(binding: OAuthBinding, rejectedToken: string): Promise<OAuthCredential> {
    const key = this.store.key(binding)
    if (this.pending.has(key)) throw new OAuthLoginRequired()
    const previous = this.refreshing.get(key)
    if (previous) return previous
    const current = this.store.read(binding)
    if (current.tokens?.access_token !== rejectedToken) return current
    if (!current.tokens?.refresh_token || !current.redirectUrl || !current.discovery)
      throw new OAuthLoginRequired()
    validateOAuthDiscovery(current.discovery, undefined, binding.url)
    const provider = new StoredOAuthProvider(current, current.redirectUrl)
    const operation = (async () => {
      try {
        const result = await auth(provider, {
          serverUrl: binding.url,
          fetchFn: oauthFetch(AbortSignal.timeout(30_000)),
        })
        if (this.closed || result !== 'AUTHORIZED') throw new OAuthLoginRequired()
        this.store.write(provider.record)
        return provider.record
      } catch {
        throw new OAuthLoginRequired()
      } finally {
        this.refreshing.delete(key)
      }
    })()
    this.refreshing.set(key, operation)
    return operation
  }

  closePeer(peerId: string): void {
    for (const flow of [...this.pending.values()])
      if (flow.peerId === peerId) flow.finish(false, 'OAuth 客户端已断开')
  }

  close(): void {
    this.closed = true
    for (const flow of [...this.pending.values()]) flow.finish(false, 'OAuth 运行时已停止')
  }
}

const managers = new Map<string, McpOAuthManager>()
export function mcpOAuthManager(): McpOAuthManager {
  const home = adapterHome()
  let manager = managers.get(home)
  if (!manager || manager.closed) {
    manager = new McpOAuthManager(home)
    managers.set(home, manager)
  }
  return manager
}
