// 飞书 CLI 的设备代理：lark-cli（sidecar 版）只拿到占位令牌，请求带 HMAC 签名发到设备的回环端口；
// 设备验签、规范化路径、按放行规则分类，换上应用令牌转发到开放平台。令牌不出设备进程。
// 一个端口，每份租约一把随机钥匙：钥匙 → 租约 → 会话 → 经理（工作线继承派出它的经理）→ 经理绑定的应用。
// 签名格式与上游 larksuite/cli 的 sidecar 协议 v1 一致（换行连接的八项，HMAC-SHA256 十六进制，时间差不超过 60 秒）。
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { FeishuApiError } from './api.mjs'
import { auditPath, type CliSpeech, normalizePath, routeCliRequest } from './cli-policy.mjs'
import { CliSpeechRefusal, cliSpeechPreview, cliSpeechTarget } from './cli-speech.mjs'
import { OutboxRefusal } from './outbox.mjs'
import type { DeviceFeishuService } from './service.mjs'
import type { FeishuAppRecord } from './store.mjs'

/** lark-cli 的配置、数据、日志目录放在设备状态目录下的这里，按应用分 */
export const FEISHU_CLI_DIRECTORY = 'feishu-cli'
const VERSION = 'v1'
const HOST = 'open.feishu.cn'
const DRIFT = 60
const BODY_MAX = 100 * 1024 * 1024
const LEASES_MAX = 128
const LEASE_TTL = 3600_000
/** 代理请求的审计留多久（秒） */
const AUDIT_KEEP = 30 * 86_400
/** 拦下或拒绝时回给 CLI 的错误码（飞书格式的响应体） */
export const FEISHU_CLI_REFUSED = 99_403

export interface FeishuCliActor {
  kind: 'manager' | 'workline'
  managerId: string
  threadId: string
}

interface Lease {
  id: string
  key: Buffer
  actor: FeishuCliActor
  appId: string
  at: number
  /** 以这个已绑定用户的身份（LITCH_FEISHU_AS_USER）；没有就只能用机器人 */
  user?: { openId: string; name: string }
}

/** null：这个会话没路由到飞书应用，交给宿主自己装的 lark-cli */
export type FeishuCliLeaseResult =
  | { lease: string; larkPath: string; env: Record<string, string> }
  | { error: string }
  | null

export interface FeishuCliProxyOptions {
  feishu: DeviceFeishuService
  stateDirectory: string
  /** 设备给的 lark-cli（sidecar 版）的路径；拿不到时抛错，消息给 Agent 看 */
  binary: () => Promise<string>
  log: (message: string) => void
}

/** 转发时不带过去的请求头（代理自己的、认证、逐跳的） */
const DROP_REQUEST =
  /^(host|connection|keep-alive|proxy-.*|te|trailer|transfer-encoding|upgrade|content-length|accept-encoding|authorization|dpop|x-lark-proxy-.*|x-lark-body-sha256|x-lark-mcp-.*)$/i
/** 回给 CLI 时不带的响应头（正文已经解过压缩、长度另算） */
const DROP_RESPONSE =
  /^(connection|keep-alive|transfer-encoding|content-encoding|content-length|set-cookie)$/i

export class FeishuCliProxy {
  private readonly options: FeishuCliProxyOptions
  private server: Server | null = null
  private listening: Promise<number> | null = null
  private readonly leases = new Map<string, Lease>()
  private prunedAt = 0
  private closed = false
  /** 租约还算数：会话仍是这位经理的经理或工作线（设备的命令入口接上） */
  current: (actor: FeishuCliActor) => boolean = () => false

  constructor(options: FeishuCliProxyOptions) {
    this.options = options
  }

  /** 给一个命令发租约 */
  async lease(actor: FeishuCliActor, asUser?: string): Promise<FeishuCliLeaseResult> {
    const { feishu } = this.options
    const app = feishu.appForManager(actor.managerId)
    if (!app || this.closed) return null
    let user: Lease['user']
    if (asUser?.trim()) {
      const found = this.user(app.appId, asUser.trim())
      if ('error' in found) return found
      user = found
    }
    if (!app.enabled)
      return {
        error: 'The Feishu app of this manager is disabled in Litch; lark-cli is unavailable.',
      }
    if (!feishu.api(app.appId))
      return {
        error: 'The Feishu app of this manager is not running; check its credentials in Litch.',
      }
    let larkPath: string
    try {
      // 命令入口只等几秒：还在下载就让 Agent 稍后重试，下载在后台接着跑
      const binary = this.options.binary()
      larkPath = await Promise.race([
        binary,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('Litch is still downloading it; retry in a minute')),
            2000,
          ).unref()
        }),
      ])
    } catch (error) {
      return { error: `lark-cli is unavailable on this device: ${(error as Error).message}` }
    }
    const port = await this.listen()
    this.sweep()
    this.prune()
    if (this.leases.size >= LEASES_MAX)
      return { error: 'Too many lark-cli commands are running; retry shortly.' }
    const key = randomBytes(32).toString('hex')
    const id = randomUUID()
    this.leases.set(id, {
      id,
      key: Buffer.from(key),
      actor,
      appId: app.appId,
      at: Date.now(),
      ...(user ? { user } : {}),
    })
    const root = join(this.options.stateDirectory, FEISHU_CLI_DIRECTORY, app.appId)
    const folder = (name: string) => {
      const path = join(root, name)
      mkdirSync(path, { recursive: true, mode: 0o700 })
      chmodSync(path, 0o700)
      return path
    }
    return {
      lease: id,
      larkPath,
      env: {
        LARKSUITE_CLI_AUTH_PROXY: `http://127.0.0.1:${port}`,
        LARKSUITE_CLI_PROXY_KEY: key,
        LARKSUITE_CLI_APP_ID: app.appId,
        LARKSUITE_CLI_BRAND: 'feishu',
        // 指定了用户：默认用户身份，也能 --as bot；没指定只能机器人
        LARKSUITE_CLI_STRICT_MODE: user ? 'off' : 'bot',
        LARKSUITE_CLI_DEFAULT_AS: user ? 'user' : 'bot',
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
        LARKSUITE_CLI_CONFIG_DIR: folder('config'),
        LARKSUITE_CLI_DATA_DIR: folder('data'),
        LARKSUITE_CLI_LOG_DIR: folder('logs'),
      },
    }
  }

  /** LITCH_FEISHU_AS_USER：名字或 open_id，按本应用已绑定的人解析；不唯一就拒绝，不猜；要有可用的授权 */
  private user(
    appId: string,
    wanted: string,
  ): { openId: string; name: string } | { error: string } {
    const { feishu } = this.options
    const bound = feishu.bindings.records(appId).filter((one) => one.state === 'bound')
    const byId = bound.find((one) => one.openId === wanted)
    const named = byId ? [byId] : bound.filter((one) => one.name === wanted)
    if (named.length === 0)
      return { error: `No user bound to this Feishu app in Litch matches ${wanted}.` }
    if (named.length > 1)
      return {
        error: `Several bound users are named ${wanted}: ${named.map((one) => one.openId).join(', ')}. Use the open_id.`,
      }
    const person = named[0] as { openId: string; name: string }
    if (!feishu.grants.active(appId, person.openId))
      return {
        error: `${person.name || person.openId} has not granted user identity (or it expired). Ask them to grant it with feishu_user_grant_request or in Litch.`,
      }
    return { openId: person.openId, name: person.name }
  }

  release(id: string): void {
    this.leases.delete(id)
  }

  /** 进程被硬杀、没归还的租约，一小时后收掉 */
  sweep(): void {
    for (const [id, lease] of this.leases)
      if (Date.now() - lease.at > LEASE_TTL) this.leases.delete(id)
  }

  /** 至多一小时一次：删掉过期的代理审计 */
  private prune(): void {
    const now = this.options.feishu.now()
    if (now - this.prunedAt < 3600) return
    this.prunedAt = now
    this.options.feishu.store.managers.db
      .prepare(
        "DELETE FROM feishu_audit WHERE at < ? AND json_extract(body, '$.action') = 'cli_request'",
      )
      .run(now - AUDIT_KEEP)
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((error: Error) => {
          this.options.log(`飞书 CLI 代理出错：${error.message}`)
          if (!res.headersSent) reply(res, 502, 'Litch proxy error.')
          else res.destroy()
        })
      })
      server.headersTimeout = 30_000
      server.requestTimeout = 300_000
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      server.unref()
      this.server = server
    })
    return this.listening
  }

  async close(): Promise<void> {
    this.closed = true
    this.leases.clear()
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** 按签名找租约：每份租约一把钥匙，逐个试（至多 128 份） */
  private match(canonical: string, signature: string): Lease | null {
    if (!/^[0-9a-f]{64}$/.test(signature)) return null
    const given = Buffer.from(signature, 'hex')
    for (const lease of this.leases.values()) {
      const expected = createHmac('sha256', lease.key).update(canonical).digest()
      if (timingSafeEqual(expected, given)) return lease
    }
    return null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = (name: string) => {
      const value = req.headers[name]
      return typeof value === 'string' ? value : ''
    }
    const method = req.method ?? ''
    const pathAndQuery = req.url ?? ''
    if (header('x-lark-proxy-version') !== VERSION)
      return reply(res, 400, 'Unsupported X-Lark-Proxy-Version.')
    const timestamp = header('x-lark-proxy-timestamp')
    const claimed = header('x-lark-body-sha256')
    const target = header('x-lark-proxy-target')
    const identity = header('x-lark-proxy-identity')
    const authHeader = header('x-lark-proxy-auth-header')
    const signature = header('x-lark-proxy-signature')
    if (!timestamp || !claimed || !target || !identity || !authHeader || !signature)
      return reply(res, 400, 'Missing sidecar headers.')
    if (!pathAndQuery.startsWith('/')) return reply(res, 400, 'Bad request target.')
    const body = await readBody(req)
    if (!body) return reply(res, 413, 'The request body is too large.')
    if (createHash('sha256').update(body).digest('hex') !== claimed)
      return reply(res, 400, 'Body SHA256 mismatch.')
    const host = targetHost(target)
    if (!host) return reply(res, 403, 'Invalid X-Lark-Proxy-Target.')
    const canonical = [
      VERSION,
      method,
      host,
      pathAndQuery,
      claimed,
      timestamp,
      identity,
      authHeader,
    ].join('\n')
    const lease = this.match(canonical, signature)
    if (!lease) return reply(res, 401, 'Signature verification failed.')
    const now = this.options.feishu.now()
    if (!/^[0-9]{1,12}$/.test(timestamp) || Math.abs(now - Number(timestamp)) > DRIFT)
      return reply(res, 401, 'The request timestamp is too far from the device clock.')
    const [rawPath = '', rawQuery = ''] = splitQuery(pathAndQuery)
    const audit = (status: number, route: string, extra: Record<string, string> = {}) =>
      this.options.feishu.store.audit(lease.appId, this.options.feishu.now(), {
        action: 'cli_request',
        by: 'device',
        detail: {
          managerId: lease.actor.managerId,
          threadId: lease.actor.threadId,
          actor: lease.actor.kind,
          identity,
          ...(identity === 'user' && lease.user ? { userOpenId: lease.user.openId } : {}),
          method,
          path: auditPath(normalizePath(rawPath) ?? '-'),
          route,
          status,
          ...extra,
        },
      })
    const refused = (status: number, message: string, route: string) => {
      audit(status, route)
      reply(res, status, message)
    }
    if (host !== HOST) return refused(403, `Target host ${host} is not allowed.`, 'host')
    if (authHeader !== 'Authorization')
      return refused(403, 'Only OpenAPI requests are proxied (no MCP).', 'auth_header')
    // CLI 每条命令开头都会用用户身份探一次 user_info：照样拒绝，但不记审计（否则全是这一条）
    const hint =
      'User identity needs a bound user who granted it: run LITCH_FEISHU_AS_USER=<name or open_id> lark-cli ...; otherwise use --as bot.'
    // CLI 每条命令开头都会用用户身份探一次 user_info：没指定用户时照样拒绝，但不记审计（否则全是这一条）
    if (
      identity === 'user' &&
      !lease.user &&
      method === 'GET' &&
      rawPath === '/open-apis/authen/v1/user_info'
    )
      return reply(res, 401, hint)
    if (identity === 'user' && !lease.user) return refused(401, hint, 'identity')
    if (identity !== 'bot' && identity !== 'user')
      return refused(403, 'Unknown identity.', 'identity')
    const app = this.options.feishu.appForManager(lease.actor.managerId)
    if (!this.current(lease.actor) || app?.appId !== lease.appId || !app.enabled)
      return refused(401, 'This lark-cli lease is no longer valid.', 'lease')
    const route = routeCliRequest(method, rawPath)
    if (route.kind === 'reject')
      return refused(
        403,
        route.reason === 'auth'
          ? 'Litch does not proxy authentication or event endpoints.'
          : route.reason === 'method'
            ? `Method ${method} is not allowed.`
            : 'The request path is not allowed.',
        route.reason,
      )
    // 用户身份：取这个人的 token（快过期先刷新）；授权失效就拒绝，不改用机器人
    let userToken: string | undefined
    if (identity === 'user' && lease.user) {
      try {
        userToken = await this.options.feishu.grants.token(lease.appId, lease.user.openId)
      } catch {
        return refused(
          401,
          `The user identity of ${lease.user.name || lease.user.openId} is no longer valid; ask them to grant it again.`,
          'user_grant',
        )
      }
    }
    const forwardHeaders = requestHeaders(req)
    if (route.kind === 'pass') {
      const status = await this.forward(
        res,
        app,
        method,
        pathAndQuery,
        forwardHeaders,
        body,
        undefined,
        userToken,
      )
      return audit(status, 'pass')
    }
    await this.speech(res, {
      app,
      lease,
      speech: route.speech,
      method,
      path: normalizePath(rawPath) ?? rawPath,
      pathAndQuery,
      query: new URLSearchParams(rawQuery),
      headers: forwardHeaders,
      body,
      audit,
      ...(userToken && lease.user ? { user: { ...lease.user, token: userToken } } : {}),
    })
  }

  /** 发言：自由发言直接转发并记进消息库；审批发言冻结转审批；不许的拒绝 */
  private async speech(
    res: ServerResponse,
    input: {
      app: FeishuAppRecord
      lease: Lease
      speech: CliSpeech
      method: string
      path: string
      pathAndQuery: string
      query: URLSearchParams
      headers: Record<string, string>
      body: Buffer
      audit: (status: number, route: string, extra?: Record<string, string>) => void
      /** 以用户身份发 */
      user?: { openId: string; name: string; token: string }
    },
  ): Promise<void> {
    const { feishu } = this.options
    const { app, lease, audit } = input
    const request = {
      app,
      speech: input.speech,
      method: input.method,
      path: input.path,
      query: input.query,
      body: input.body,
      ...(input.headers['content-type'] ? { contentType: input.headers['content-type'] } : {}),
    }
    try {
      const target = await cliSpeechTarget(feishu, request)
      if (target.mode === 'free') {
        const status = await this.forward(
          res,
          app,
          input.method,
          input.pathAndQuery,
          input.headers,
          input.body,
          (data) => {
            if (typeof data.message_id !== 'string' || typeof data.chat_id !== 'string') return
            try {
              feishu.records.storeSent(app.appId, data, target.kind === 'chat' ? 'group' : 'p2p')
            } catch (error) {
              this.options.log(`飞书 CLI 发出的消息记录失败：${(error as Error).message}`)
            }
          },
          input.user?.token,
        )
        return audit(status, 'speech_free')
      }
      const preview = cliSpeechPreview(request)
      const record = feishu.outbox.submitCli({
        app,
        managerId: lease.actor.managerId,
        threadId: lease.actor.threadId,
        target,
        cli: { ...preview.cli, path: auditPath(input.path) },
        raw: {
          method: input.method,
          pathAndQuery: input.pathAndQuery,
          ...(request.contentType ? { contentType: request.contentType } : {}),
          body: input.body,
        },
        msgType: preview.msgType,
        format: preview.format,
        summary: preview.summary,
        preview: preview.parts,
        ...(preview.replyTo ? { replyTo: preview.replyTo } : {}),
        ...(input.user
          ? {
              actingAs: { type: 'user' as const, openId: input.user.openId, name: input.user.name },
            }
          : {}),
      })
      const reviewId = record.reviewId ?? ''
      audit(403, 'speech_review', { reviewId, operationId: record.operationId })
      reply(
        res,
        403,
        `已转审批（${reviewId}），不要重试；审批结果会在对话里告诉你。Sent for approval (${reviewId}) in Litch; do not retry, the result will be reported in this conversation.`,
        { litch_review_id: reviewId, litch_operation_id: record.operationId },
      )
    } catch (error) {
      if (!(error instanceof CliSpeechRefusal || error instanceof OutboxRefusal)) throw error
      audit(403, 'speech_refused')
      reply(res, 403, error.message)
    }
  }

  /** 换上令牌原样转发；JSON 响应读完再回（并交给 onData），其余的边收边回。返回状态码 */
  private async forward(
    res: ServerResponse,
    app: FeishuAppRecord,
    method: string,
    pathAndQuery: string,
    headers: Record<string, string>,
    body: Buffer,
    onData?: (data: Record<string, unknown>) => void,
    userToken?: string,
  ): Promise<number> {
    const api = this.options.feishu.api(app.appId)
    if (!api) {
      reply(res, 503, 'The Feishu app is not running.')
      return 503
    }
    let answer: Awaited<ReturnType<typeof api.forward>>
    try {
      answer = await api.forward(method, pathAndQuery, headers, body, userToken)
    } catch (error) {
      const kind = error instanceof FeishuApiError ? error.kind : 'network'
      const status = kind === 'credential_rejected' ? 502 : 504
      reply(
        res,
        status,
        kind === 'credential_rejected'
          ? 'Feishu rejected the app credentials; check them in Litch.'
          : 'Feishu could not be reached.',
      )
      return status
    }
    const out: Record<string, string> = {}
    answer.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.test(name)) out[name] = value
    })
    res.writeHead(answer.status, out)
    if (answer.json) {
      res.end(answer.json.bytes)
      const data = answer.json.data
      if (answer.json.code === 0 && data && typeof data === 'object' && !Array.isArray(data))
        onData?.(data as Record<string, unknown>)
    } else if (answer.stream) Readable.fromWeb(answer.stream as never).pipe(res)
    else res.end()
    return answer.status
  }
}

/** 飞书格式的错误响应 */
function reply(
  res: ServerResponse,
  status: number,
  message: string,
  data?: Record<string, string>,
): void {
  const body = JSON.stringify({ code: FEISHU_CLI_REFUSED, msg: message, ...(data ? { data } : {}) })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function splitQuery(pathAndQuery: string): [string, string] {
  const index = pathAndQuery.indexOf('?')
  return index < 0
    ? [pathAndQuery, '']
    : [pathAndQuery.slice(0, index), pathAndQuery.slice(index + 1)]
}

/** X-Lark-Proxy-Target 只能是 https://主机，不带端口以外的东西 */
function targetHost(target: string): string | null {
  try {
    const url = new URL(target)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null
    return url.host || null
  } catch {
    return null
  }
}

function requestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers))
    if (!DROP_REQUEST.test(name) && typeof value === 'string') out[name] = value
  return out
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const parts: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_MAX) return null
    parts.push(chunk as Buffer)
  }
  return Buffer.concat(parts)
}
