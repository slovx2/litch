// 假飞书开放平台：回环上的 HTTP 加长连接，给设备的飞书来源做端到端测试。只实现设备用得到的接口，
// 形状照飞书开放平台的官方文档。不连真实飞书，也不需要任何真实凭据。
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import { decodeFrame, encodeFrame, type Frame, header } from './feishu-fake-frame.mjs'

export interface FakeMember {
  openId: string
  name: string
  unionId?: string
}

export interface FakeChat {
  chatId: string
  name: string
  external: boolean
  status: 'normal' | 'dissolved'
  /** 机器人在这个群里的应用 */
  bots: Set<string>
  members: FakeMember[]
  createdAt: number
}

export interface FakeMessage {
  message_id: string
  chat_id: string
  chat_type: 'group' | 'p2p'
  root_id?: string
  parent_id?: string
  msg_type: string
  content: string
  create_time: string
  update_time: string
  deleted: boolean
  updated: boolean
  sender: {
    id: string
    id_type: 'open_id' | 'app_id'
    sender_type: 'user' | 'app'
    tenant_key: string
  }
  mentions?: { key: string; id: string; id_type: 'open_id'; name: string; tenant_key: string }[]
  /** 合并转发的子消息：读单条消息时跟在父消息后面一起返回 */
  children?: FakeMessage[]
  /** 卡片的原始 JSON：读单条消息带 card_msg_content_type=user_card_content 时返回它 */
  cardRaw?: string
}

export interface FakeApp {
  appId: string
  secret: string
  botOpenId: string
  botName: string
  /** 能力自检用：已生效的权限、在线版本订阅的事件与回调 */
  scopes: Set<string>
  /** 用户身份权限（scope_type=user） */
  userScopes: Set<string>
  /** 应用信息的 allow_refresh_token */
  allowRefreshToken: boolean
  events: Set<string>
  callbacks: Set<string>
}

export interface SentRequest {
  appId: string
  path: string
  query: Record<string, string>
  body: Record<string, unknown>
  uuid?: string
  messageId: string
}

const TENANT = 'tenant-fake'

interface Socket {
  appId: string
  ws: WebSocket
}

interface PendingAck {
  resolve: (payload: Record<string, unknown>) => void
}

export class FakeFeishu {
  readonly apps = new Map<string, FakeApp>()
  readonly chats = new Map<string, FakeChat>()
  readonly messages: FakeMessage[] = []
  readonly sent: SentRequest[] = []
  readonly calls: { appId: string; method: string; path: string; userOpenId?: string }[] = []
  /** 用户身份授权：设备码 → 申请 */
  readonly grantRequests = new Map<
    string,
    {
      appId: string
      scope: string
      userCode: string
      state: 'pending' | 'approved' | 'denied'
      openId?: string
    }
  >()
  /** 用户 token → 谁 */
  readonly userTokens = new Map<string, { appId: string; openId: string }>()
  private readonly refreshTokens = new Map<string, { appId: string; openId: string }>()
  /** 撤销过的 token */
  readonly revoked: string[] = []
  /** 刷新一律拒绝（模拟用户在飞书里取消了授权） */
  rejectRefresh = false
  /** 授权时不给 refresh token（应用没开刷新） */
  omitRefreshToken = false

  /** 本人在飞书里点了同意（openId 是实际点的人） */
  approveGrant(userCode: string, openId: string): void {
    for (const request of this.grantRequests.values())
      if (request.userCode === userCode) Object.assign(request, { state: 'approved', openId })
  }

  denyGrant(userCode: string): void {
    for (const request of this.grantRequests.values())
      if (request.userCode === userCode) request.state = 'denied'
  }

  private issueUserTokens(appId: string, openId: string, scope: string) {
    const accessToken = `u-${randomBytes(8).toString('hex')}`
    const refreshToken = this.omitRefreshToken ? '' : `r-${randomBytes(8).toString('hex')}`
    this.userTokens.set(accessToken, { appId, openId })
    if (refreshToken) this.refreshTokens.set(refreshToken, { appId, openId })
    return {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken, refresh_token_expires_in: 604800 } : {}),
      expires_in: 7200,
      token_type: 'Bearer',
      scope,
    }
  }
  readonly uploads = new Map<string, { appId: string; kind: 'image' | 'file'; bytes: number }>()
  /** 消息里的资源（图片、文件）：按 file_key 给字节 */
  readonly resources = new Map<string, { bytes: Buffer; type: string }>()
  readonly sockets: Socket[] = []
  readonly patches: { appId: string; body: Record<string, unknown> }[] = []
  readonly publishes: { appId: string; body: Record<string, unknown> }[] = []
  /**
   * 接下来几次发消息的故障：drop=照常发出但断开连接（发送结果不明）；reset=没发就断开；error=按错误码拒绝
   * （同一 uuid 已发过的照常去重返回，不消耗故障）
   */
  sendFaults: ({ kind: 'drop' | 'reset' } | { kind: 'error'; code: number; status?: number })[] = []
  private abort: (() => void) | null = null
  /** 换令牌失败的应用（凭据被拒） */
  readonly rejectToken = new Set<string>()
  /** 长连接拉配置时返回系统繁忙（可重试）的次数 */
  busyEndpoints = 0
  /** 历史接口一页最多几条 */
  pageSize = 50
  users = new Map<string, { name: string; unionId?: string }>()
  registration: {
    deviceCode: string
    polls: number
    /** 第几次轮询才完成；0 表示一直等 */
    completeAfter: number
    /** 照真实返回：创建者和租户品牌都在 user_info 里 */
    result?: {
      client_id: string
      client_secret: string
      user_info?: { open_id?: string; tenant_brand?: string }
    }
    error?: string
  } | null = null
  private server?: Server
  private wss?: WebSocketServer
  private readonly tokens = new Map<string, string>()
  private readonly acks = new Map<string, PendingAck>()
  private sequence = 0

  origin = ''

  addApp(app: Partial<FakeApp> & { appId: string }): FakeApp {
    const value: FakeApp = {
      secret: `secret-${app.appId}`,
      botOpenId: `ou_bot_${app.appId.slice(-6)}`,
      botName: '测试机器人',
      scopes: new Set(),
      userScopes: new Set(),
      allowRefreshToken: true,
      events: new Set(),
      callbacks: new Set(),
      ...app,
    }
    this.apps.set(value.appId, value)
    return value
  }

  addChat(chat: Partial<FakeChat> & { chatId: string; name: string }): FakeChat {
    const value: FakeChat = {
      external: false,
      status: 'normal',
      bots: new Set(),
      members: [],
      createdAt: Date.now(),
      ...chat,
    }
    this.chats.set(value.chatId, value)
    return value
  }

  /** 群里有人说了一句话（存进历史，不推事件）；返回消息 */
  postMessage(input: {
    chatId: string
    sender: string
    text?: string
    msgType?: string
    content?: string
    at?: number
    parentId?: string
    mentions?: { openId: string; name: string }[]
    chatType?: 'group' | 'p2p'
  }): FakeMessage {
    const at = input.at ?? Date.now()
    const mentions = (input.mentions ?? []).map((item, index) => ({
      key: `@_user_${index + 1}`,
      id: item.openId,
      id_type: 'open_id' as const,
      name: item.name,
      tenant_key: TENANT,
    }))
    const message: FakeMessage = {
      message_id: `om_${randomBytes(8).toString('hex')}`,
      chat_id: input.chatId,
      chat_type: input.chatType ?? 'group',
      msg_type: input.msgType ?? 'text',
      content: input.content ?? JSON.stringify({ text: input.text ?? '' }),
      create_time: String(at),
      update_time: String(at),
      deleted: false,
      updated: false,
      sender: { id: input.sender, id_type: 'open_id', sender_type: 'user', tenant_key: TENANT },
      ...(input.parentId ? { parent_id: input.parentId, root_id: input.parentId } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
    }
    this.messages.push(message)
    return message
  }

  /** 收消息事件的 event 部分（照 im.message.receive_v1） */
  receiveEvent(message: FakeMessage): Record<string, unknown> {
    const user = this.users.get(message.sender.id)
    return {
      sender: {
        sender_id: {
          open_id: message.sender.id,
          ...(user?.unionId ? { union_id: user.unionId } : {}),
        },
        sender_type: 'user',
        tenant_key: TENANT,
      },
      message: {
        message_id: message.message_id,
        ...(message.root_id ? { root_id: message.root_id } : {}),
        ...(message.parent_id ? { parent_id: message.parent_id } : {}),
        create_time: message.create_time,
        update_time: message.update_time,
        chat_id: message.chat_id,
        chat_type: message.chat_type,
        message_type: message.msg_type,
        content: message.content,
        ...(message.mentions
          ? {
              mentions: message.mentions.map((item) => ({
                key: item.key,
                id: { open_id: item.id },
                name: item.name,
                tenant_key: TENANT,
              })),
            }
          : {}),
      },
    }
  }

  /** 经长连接推一个事件给应用的全部连接，等第一条连接回 ACK，返回 ACK 的内容 */
  async push(
    appId: string,
    eventType: string,
    event: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const targets = this.sockets.filter(
      (item) => item.appId === appId && item.ws.readyState === WebSocket.OPEN,
    )
    if (targets.length === 0) throw new Error(`应用 ${appId} 没有连上的长连接`)
    const messageId = randomUUID()
    const envelope = {
      schema: '2.0',
      header: {
        event_id: randomUUID(),
        event_type: eventType,
        create_time: String(Date.now()),
        token: '',
        app_id: appId,
        tenant_key: TENANT,
      },
      event,
    }
    const frame: Frame = {
      SeqID: ++this.sequence,
      LogID: this.sequence,
      service: 1,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: messageId },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: randomUUID() },
      ],
      payload: new TextEncoder().encode(JSON.stringify(envelope)),
    }
    const acked = new Promise<Record<string, unknown>>((resolve) =>
      this.acks.set(messageId, { resolve }),
    )
    targets[0]?.ws.send(encodeFrame(frame))
    return await acked
  }

  /** 断开某应用的全部长连接（模拟网络断开）；SDK 会自己重连 */
  drop(appId: string): void {
    for (const socket of this.sockets.filter((item) => item.appId === appId)) socket.ws.terminate()
  }

  connected(appId: string): number {
    return this.sockets.filter(
      (item) => item.appId === appId && item.ws.readyState === WebSocket.OPEN,
    ).length
  }

  async start(): Promise<void> {
    this.wss = new WebSocketServer({ noServer: true })
    this.server = createServer((request, response) => {
      this.route(request, response).catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 500, msg: String(error) }))
      })
    })
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://fake')
      const appId = url.searchParams.get('app_id') ?? ''
      if (url.pathname !== '/ws' || !this.apps.has(appId)) {
        socket.destroy()
        return
      }
      this.wss?.handleUpgrade(request, socket, head, (ws) => this.accept(appId, ws))
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.origin = `http://127.0.0.1:${port}`
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.ws.terminate()
    this.wss?.close()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.closeAllConnections()
      this.server.close(() => resolve())
    })
  }

  private accept(appId: string, ws: WebSocket): void {
    const entry = { appId, ws }
    this.sockets.push(entry)
    ws.on('close', () => {
      const index = this.sockets.indexOf(entry)
      if (index >= 0) this.sockets.splice(index, 1)
    })
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(new Uint8Array(data))
      const type = header(frame, 'type')
      if (frame.method === 0 && type === 'ping') {
        ws.send(
          encodeFrame({
            ...frame,
            headers: [{ key: 'type', value: 'pong' }],
            payload: new TextEncoder().encode(
              JSON.stringify({
                PingInterval: 120,
                ReconnectCount: -1,
                ReconnectInterval: 1,
                ReconnectNonce: 0,
              }),
            ),
          }),
        )
        return
      }
      if (frame.method === 1) {
        const id = header(frame, 'message_id') ?? ''
        const pending = this.acks.get(id)
        if (!pending) return
        this.acks.delete(id)
        const text = new TextDecoder().decode(frame.payload ?? new Uint8Array())
        const ack = JSON.parse(text) as Record<string, unknown>
        if (typeof ack.data === 'string') {
          try {
            ack.data = JSON.parse(Buffer.from(ack.data, 'base64').toString('utf8'))
          } catch {}
        }
        pending.resolve(ack)
      }
    })
  }

  private appOf(request: IncomingMessage): FakeApp | undefined {
    const auth = request.headers.authorization ?? ''
    const token = auth.replace(/^Bearer /, '')
    const appId = this.tokens.get(token) ?? this.userTokens.get(token)?.appId
    return appId ? this.apps.get(appId) : undefined
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin)
    const path = url.pathname
    const method = request.method ?? 'GET'
    const raw = await readBody(request)
    const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
      response.end(JSON.stringify(body))
    }
    const json = (): Record<string, unknown> => {
      try {
        return JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>
      } catch {
        return {}
      }
    }
    if (path === '/callback/ws/endpoint' && method === 'POST') {
      const body = json()
      const app = this.apps.get(String(body.AppID ?? ''))
      if (!app || app.secret !== body.AppSecret)
        return reply({ code: 514, msg: 'auth failed', data: {} })
      if (this.busyEndpoints > 0) {
        this.busyEndpoints--
        return reply({ code: 1000040343, msg: 'system busy', data: {} })
      }
      const ws = this.origin.replace('http://', 'ws://')
      return reply({
        code: 0,
        msg: 'ok',
        data: {
          URL: `${ws}/ws?device_id=fake&service_id=1&app_id=${app.appId}`,
          ClientConfig: {
            PingInterval: 120,
            ReconnectCount: -1,
            ReconnectInterval: 1,
            ReconnectNonce: 0,
          },
        },
      })
    }
    if (path === '/oauth/v1/device_authorization' && method === 'POST') {
      const form = new URLSearchParams(raw.toString('utf8'))
      const [id, secret] = Buffer.from(
        (request.headers.authorization ?? '').replace(/^Basic /, ''),
        'base64',
      )
        .toString('utf8')
        .split(':')
      const app = this.apps.get(id ?? '')
      if (!app || app.secret !== secret || form.get('client_id') !== app.appId)
        return reply({ error: 'invalid_client' }, 401)
      const deviceCode = `udc-${randomBytes(6).toString('hex')}`
      const userCode = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`
      this.grantRequests.set(deviceCode, {
        appId: app.appId,
        scope: form.get('scope') ?? '',
        userCode,
        state: 'pending',
      })
      return reply({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: 'https://accounts.feishu.cn/oauth/v1/device/verify',
        verification_uri_complete: `https://accounts.feishu.cn/oauth/v1/device/verify?user_code=${userCode}`,
        expires_in: 240,
        interval: 1,
      })
    }
    if (path === '/oauth/v3/token' && method === 'POST') {
      const form = request.headers['content-type']?.includes('json')
        ? new URLSearchParams(Object.entries(json()).map(([k, v]) => [k, String(v)]))
        : new URLSearchParams(raw.toString('utf8'))
      const app = this.apps.get(form.get('client_id') ?? '')
      if (!app || app.secret !== form.get('client_secret'))
        return reply({ error: 'invalid_client' }, 401)
      if (form.get('grant_type') === 'refresh_token') {
        const who = this.refreshTokens.get(form.get('refresh_token') ?? '')
        if (!who || this.rejectRefresh) return reply({ code: 20064, error: 'invalid_grant' }, 400)
        this.refreshTokens.delete(form.get('refresh_token') ?? '')
        return reply({ code: 0, ...this.issueUserTokens(app.appId, who.openId, '') })
      }
      const grant = this.grantRequests.get(form.get('device_code') ?? '')
      if (!grant) return reply({ error: 'invalid_grant' }, 400)
      if (grant.state === 'pending') return reply({ error: 'authorization_pending' }, 400)
      if (grant.state === 'denied') return reply({ error: 'access_denied' }, 400)
      this.grantRequests.delete(form.get('device_code') ?? '')
      return reply(
        this.issueUserTokens(
          app.appId,
          grant.openId ?? '',
          grant.scope.replace(' offline_access', ''),
        ),
      )
    }
    if (path === '/oauth/v1/revoke' && method === 'POST') {
      const form = new URLSearchParams(raw.toString('utf8'))
      const token = form.get('token') ?? ''
      this.revoked.push(token)
      this.userTokens.delete(token)
      this.refreshTokens.delete(token)
      return reply({})
    }
    if (path === '/open-apis/authen/v1/user_info' && method === 'GET') {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
      const who = this.userTokens.get(token)
      if (!who) return reply({ code: 99991668, msg: 'invalid user token' }, 400)
      this.calls.push({ appId: who.appId, method, path, userOpenId: who.openId })
      return reply({
        code: 0,
        msg: 'ok',
        data: { open_id: who.openId, name: this.users.get(who.openId)?.name ?? '' },
      })
    }
    if (path === '/oauth/v1/app/registration' && method === 'POST') {
      this.register(new URLSearchParams(raw.toString('utf8')), reply)
      return
    }
    if (path === '/open-apis/auth/v3/tenant_access_token/internal' && method === 'POST') {
      const body = json()
      const app = this.apps.get(String(body.app_id ?? ''))
      if (!app || app.secret !== body.app_secret || this.rejectToken.has(app.appId)) {
        return reply({ code: 10014, msg: 'app secret invalid' })
      }
      const token = `t-${randomBytes(8).toString('hex')}`
      this.tokens.set(token, app.appId)
      return reply({ code: 0, msg: 'ok', tenant_access_token: token, expire: 7200 })
    }
    const app = this.appOf(request)
    if (!app) return reply({ code: 99991663, msg: 'invalid access token' }, 400)
    const resource = /^\/open-apis\/im\/v1\/messages\/[^/]+\/resources\/([^/]+)$/.exec(url.pathname)
    const bytes = resource?.[1] ? this.resources.get(decodeURIComponent(resource[1])) : undefined
    if (bytes && method === 'GET') {
      this.calls.push({ appId: app.appId, method, path: url.pathname })
      response.writeHead(200, { 'content-type': bytes.type })
      response.end(bytes.bytes)
      return
    }
    const userOpenId = this.userTokens.get(
      (request.headers.authorization ?? '').replace(/^Bearer /, ''),
    )?.openId
    this.calls.push({ appId: app.appId, method, path, ...(userOpenId ? { userOpenId } : {}) })
    this.abort = () => response.destroy()
    return this.api(app, method, path, url, raw, json, reply)
  }

  private register(
    form: URLSearchParams,
    reply: (body: unknown, status?: number) => void,
  ): unknown {
    const action = form.get('action')
    if (action === 'begin') {
      const deviceCode = `dc-${randomBytes(6).toString('hex')}`
      this.registration = {
        completeAfter: 1,
        ...this.registration,
        deviceCode,
        polls: 0,
      }
      return reply({
        device_code: deviceCode,
        verification_uri_complete: `https://open.feishu.cn/page/launcher?user_code=FAKE`,
        interval: 1,
        expire_in: 600,
      })
    }
    if (action === 'poll') {
      const registration = this.registration
      if (!registration || form.get('device_code') !== registration.deviceCode) {
        return reply({ error: 'invalid_grant' }, 400)
      }
      registration.polls++
      if (registration.error) return reply({ error: registration.error }, 400)
      if (
        registration.completeAfter === 0 ||
        registration.polls < registration.completeAfter ||
        !registration.result
      ) {
        return reply({ error: 'authorization_pending' }, 400)
      }
      return reply(registration.result)
    }
    reply({ error: 'unsupported' }, 400)
  }

  private async api(
    app: FakeApp,
    method: string,
    path: string,
    url: URL,
    raw: Buffer,
    json: () => Record<string, unknown>,
    reply: (body: unknown, status?: number, headers?: Record<string, string>) => void,
  ): Promise<void> {
    const ok = (data: unknown) => reply({ code: 0, msg: 'success', data })
    const query = Object.fromEntries(url.searchParams)
    const page = <T,>(items: T[], size: number) => {
      const start = Number(url.searchParams.get('page_token') || '0')
      const slice = items.slice(start, start + size)
      const next = start + slice.length
      return {
        items: slice,
        has_more: next < items.length,
        ...(next < items.length ? { page_token: String(next) } : {}),
      }
    }
    if (path === '/open-apis/bot/v3/info' && method === 'GET') {
      return reply({
        code: 0,
        msg: 'ok',
        bot: { open_id: app.botOpenId, app_name: app.botName, avatar_url: '', activate_status: 2 },
      })
    }
    if (path === '/open-apis/im/v1/chats' && method === 'GET') {
      const chats = [...this.chats.values()]
        .filter((chat) => chat.bots.has(app.appId))
        .map((chat) => ({
          chat_id: chat.chatId,
          name: chat.name,
          avatar: '',
          description: '',
          owner_id: '',
          external: chat.external,
          tenant_key: TENANT,
          chat_status: chat.status,
        }))
      return ok(page(chats, Math.min(100, Number(url.searchParams.get('page_size') || '20'))))
    }
    const chatMatch = /^\/open-apis\/im\/v1\/chats\/([^/]+)(\/members)?$/.exec(path)
    if (chatMatch && method === 'GET') {
      const chat = this.chats.get(decodeURIComponent(chatMatch[1] ?? ''))
      if (!chat?.bots.has(app.appId)) return reply({ code: 232011, msg: 'bot not in chat' }, 400)
      if (chatMatch[2]) {
        const members = chat.members.map((member) => ({
          member_id_type: 'open_id',
          member_id: member.openId,
          name: member.name,
          tenant_key: TENANT,
        }))
        return ok({
          ...page(members, Math.min(100, Number(url.searchParams.get('page_size') || '20'))),
          member_total: members.length,
        })
      }
      return ok({
        name: chat.name,
        external: chat.external,
        chat_mode: 'group',
        user_count: String(chat.members.length),
        chat_status: chat.status,
      })
    }
    if (path === '/open-apis/im/v1/messages' && method === 'GET') {
      const chatId = url.searchParams.get('container_id') ?? ''
      const chat = this.chats.get(chatId)
      if (chat && !chat.bots.has(app.appId))
        return reply({ code: 230002, msg: 'bot not in chat' }, 400)
      const startTime = Number(url.searchParams.get('start_time') ?? '0') * 1000
      const endTime = url.searchParams.has('end_time')
        ? Number(url.searchParams.get('end_time')) * 1000 + 999
        : Number.POSITIVE_INFINITY
      const desc = url.searchParams.get('sort_type') === 'ByCreateTimeDesc'
      const items = this.messages
        .filter((message) => message.chat_id === chatId)
        .filter(
          (message) =>
            Number(message.create_time) >= startTime && Number(message.create_time) <= endTime,
        )
        .sort((a, b) => (desc ? -1 : 1) * (Number(a.create_time) - Number(b.create_time)))
        .map(listItem)
      return ok(
        page(items, Math.min(this.pageSize, Number(url.searchParams.get('page_size') || '20'))),
      )
    }
    const messageMatch =
      /^\/open-apis\/im\/v1\/messages\/([^/]+)(\/reply|\/resources\/([^/]+))?$/.exec(path)
    if (messageMatch && method === 'GET' && !messageMatch[2]) {
      const all = this.messages.flatMap((item) => [item, ...(item.children ?? [])])
      const message = all.find((item) => item.message_id === messageMatch[1])
      if (!message) return reply({ code: 230011, msg: 'message not found' }, 400)
      const raw = url.searchParams.get('card_msg_content_type') === 'user_card_content'
      const item = (one: FakeMessage) =>
        raw && one.cardRaw ? listItem({ ...one, content: one.cardRaw }) : listItem(one)
      return ok({ items: [item(message), ...(message.children ?? []).map(item)] })
    }
    if (messageMatch?.[3] && method === 'GET') {
      response404Safe(reply)
      return
    }
    if (path === '/open-apis/im/v1/messages' && method === 'POST') {
      this.send(app, path, query, json(), undefined, reply)
      return
    }
    if (messageMatch?.[2] === '/reply' && method === 'POST') {
      const parent = this.messages.find((item) => item.message_id === messageMatch[1])
      if (!parent) return reply({ code: 230011, msg: 'message not found' }, 400)
      this.send(app, path, query, json(), parent, reply)
      return
    }
    if (messageMatch && method === 'PATCH') {
      const message = this.messages.find((item) => item.message_id === messageMatch[1])
      if (!message) return reply({ code: 230011, msg: 'message not found' }, 400)
      const body = json()
      message.content = String(body.content ?? message.content)
      message.updated = true
      message.update_time = String(Date.now())
      return ok({})
    }
    if (
      (path === '/open-apis/im/v1/images' || path === '/open-apis/im/v1/files') &&
      method === 'POST'
    ) {
      const kind = path.endsWith('images') ? 'image' : 'file'
      const key = `${kind === 'image' ? 'img' : 'file'}_${randomBytes(6).toString('hex')}`
      this.uploads.set(key, { appId: app.appId, kind, bytes: raw.length })
      return ok(kind === 'image' ? { image_key: key } : { file_key: key })
    }
    const userMatch = /^\/open-apis\/contact\/v3\/users\/([^/]+)$/.exec(path)
    if (userMatch && method === 'GET') {
      const user = this.users.get(decodeURIComponent(userMatch[1] ?? ''))
      if (!user) return reply({ code: 41050, msg: 'no user authority' }, 400)
      return ok({
        user: {
          open_id: userMatch[1],
          name: user.name,
          ...(user.unionId ? { union_id: user.unionId } : {}),
        },
      })
    }
    if (
      path.startsWith('/open-apis/application/v6/applications/me') &&
      !app.scopes.has('application:application:self_manage')
    )
      return reply({ code: 99991672, msg: 'no permission' }, 400)
    if (path === '/open-apis/application/v6/applications/me' && method === 'GET') {
      return ok({
        app: {
          app_id: app.appId,
          status: 1,
          online_version_id: 'v1',
          mobile_default_ability: 'bot',
          pc_default_ability: 'bot',
          callback_info: { subscribed_callbacks: [...app.callbacks] },
          allow_refresh_token: app.allowRefreshToken,
        },
      })
    }
    if (path === '/open-apis/application/v6/applications/me/app_versions' && method === 'GET') {
      return ok({
        items: [
          {
            version_id: 'v1',
            version: '1.0.0',
            status: 1,
            event_infos: [...app.events].map((event_type) => ({ event_type })),
          },
        ],
        has_more: false,
      })
    }
    if (path === '/open-apis/application/v6/scopes' && method === 'GET') {
      return ok({
        scopes: [
          ...[...app.scopes].map((scope_name) => ({
            scope_name,
            scope_type: 'tenant',
            grant_status: 1,
          })),
          ...[...app.userScopes].map((scope_name) => ({
            scope_name,
            scope_type: 'user',
            grant_status: 1,
          })),
        ],
      })
    }
    const configMatch =
      /^\/open-apis\/application\/v7\/applications\/([^/]+)\/(config|publish)$/.exec(path)
    if (configMatch && configMatch[1] === app.appId) {
      if (!app.scopes.has('application:application:patch'))
        return reply({ code: 99991672, msg: 'no permission' }, 400)
      if (configMatch[2] === 'config' && method === 'PATCH') {
        this.patches.push({ appId: app.appId, body: json() })
        return ok({})
      }
      if (configMatch[2] === 'publish' && method === 'POST') {
        const body = json()
        // 开着机器人能力时两端默认能力是必填，缺了回 210304（真实平台的行为）
        if (
          !body.mobile_default_ability ||
          !body.pc_default_ability ||
          !body.remark ||
          !body.changelog
        )
          return reply({ code: 210304, msg: 'Missing required fields' }, 400)
        this.publishes.push({ appId: app.appId, body })
        return ok({ version_id: `v${this.publishes.length + 1}` })
      }
    }
    reply({ code: 404, msg: `fake: ${method} ${path} not implemented` }, 404)
  }

  private send(
    app: FakeApp,
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown>,
    parent: FakeMessage | undefined,
    reply: (body: unknown, status?: number) => void,
  ): unknown {
    const uuid = typeof body.uuid === 'string' ? body.uuid : undefined
    const repeat = uuid
      ? this.sent.find((item) => item.appId === app.appId && item.uuid === uuid)
      : undefined
    const existing = repeat && this.messages.find((item) => item.message_id === repeat.messageId)
    if (existing) return reply({ code: 0, msg: 'success', data: listItem(existing) })
    const fault = this.sendFaults.shift()
    if (fault?.kind === 'error')
      return reply({ code: fault.code, msg: 'injected failure' }, fault.status ?? 400)
    if (fault?.kind === 'reset') return this.abort?.()
    let chatId = parent?.chat_id
    if (!chatId) {
      const receiveId = String(body.receive_id ?? '')
      if (query.receive_id_type === 'chat_id') chatId = receiveId
      else chatId = `oc_p2p_${receiveId}`
    }
    const chat = this.chats.get(chatId)
    if (chat && !chat.bots.has(app.appId))
      return reply({ code: 230002, msg: 'bot not in chat' }, 400)
    const at = Date.now()
    const message: FakeMessage = {
      message_id: `om_${randomBytes(8).toString('hex')}`,
      chat_id: chatId,
      chat_type: chat ? 'group' : 'p2p',
      msg_type: String(body.msg_type ?? 'text'),
      content: String(body.content ?? ''),
      create_time: String(at),
      update_time: String(at),
      deleted: false,
      updated: false,
      sender: { id: app.appId, id_type: 'app_id', sender_type: 'app', tenant_key: TENANT },
      ...(parent
        ? { parent_id: parent.message_id, root_id: parent.root_id ?? parent.message_id }
        : {}),
    }
    this.messages.push(message)
    this.sent.push({
      appId: app.appId,
      path,
      query,
      body,
      ...(uuid ? { uuid } : {}),
      messageId: message.message_id,
    })
    if (fault?.kind === 'drop') return this.abort?.()
    reply({ code: 0, msg: 'success', data: listItem(message) })
  }
}

function response404Safe(reply: (body: unknown, status?: number) => void): void {
  reply({ code: 234003, msg: 'resource not found' }, 400)
}

function listItem(message: FakeMessage): Record<string, unknown> {
  return {
    message_id: message.message_id,
    ...(message.root_id ? { root_id: message.root_id } : {}),
    ...(message.parent_id ? { parent_id: message.parent_id } : {}),
    msg_type: message.msg_type,
    create_time: message.create_time,
    update_time: message.update_time,
    deleted: message.deleted,
    updated: message.updated,
    chat_id: message.chat_id,
    sender: message.sender,
    body: { content: message.deleted ? '' : message.content },
    ...(message.mentions ? { mentions: message.mentions } : {}),
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
