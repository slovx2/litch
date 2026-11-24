// 用户身份授权（D-179）用到的飞书 OAuth 接口：设备码申请、轮询换 token、刷新、撤销、查是谁。
// 和官方 lark-cli 的 auth login 一样走 accounts 域名的设备码流程，不用配置重定向地址；设备是服务端，用普通 Bearer，不用 DPoP。
import type { FeishuEndpoints } from './api.mjs'

/** 用户身份要的权限（D-183）：云文档、云空间、知识库、表格、多维表格、日历、任务、通讯录只读，以用户身份发消息和读消息 */
export const FEISHU_USER_SCOPES = [
  'docx:document:readonly',
  'docx:document:create',
  'docx:document:write_only',
  'docs:document.media:download',
  'docs:document.media:upload',
  'docs:document.comment:read',
  'docs:document.comment:create',
  'docs:document.content:read',
  'search:docs:read',
  'drive:drive.metadata:readonly',
  'drive:file:download',
  'drive:file:upload',
  'space:document:retrieve',
  'space:folder:create',
  'wiki:node:read',
  'wiki:node:retrieve',
  'wiki:node:create',
  'wiki:space:read',
  'sheets:spreadsheet:read',
  'sheets:spreadsheet:create',
  'sheets:spreadsheet:write_only',
  'sheets:spreadsheet.meta:read',
  'base:app:read',
  'base:app:create',
  'base:app:update',
  'base:table:read',
  'base:field:read',
  'base:view:read',
  'base:record:read',
  'base:record:create',
  'base:record:update',
  'calendar:calendar:read',
  'calendar:calendar.event:read',
  'calendar:calendar.event:create',
  'calendar:calendar.event:update',
  'calendar:calendar.event:reply',
  'calendar:calendar.free_busy:read',
  'task:task:read',
  'task:task:write',
  'task:tasklist:read',
  'task:tasklist:write',
  'task:comment:read',
  'task:comment:write',
  'contact:user.basic_profile:readonly',
  'contact:user:search',
  'im:message',
  'im:message.send_as_user',
  'im:message:readonly',
  'im:message.group_msg:get_as_user',
  'im:message.p2p_msg:get_as_user',
  'im:chat:read',
] as const

/** 授权接口出错：code 是给界面和审计的原因代码 */
export class FeishuOAuthError extends Error {
  readonly code: string
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

export interface DeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUrl: string
  /** 秒 */
  expiresIn: number
  interval: number
}

export interface UserTokens {
  accessToken: string
  refreshToken: string
  /** 秒 */
  expiresIn: number
  refreshExpiresIn: number
  scopes: string[]
}

export type PollResult =
  | { state: 'pending'; slowDown?: boolean }
  | { state: 'denied' }
  | { state: 'expired' }
  | { state: 'granted'; tokens: UserTokens }

type Json = Record<string, unknown>

export class FeishuOAuth {
  private readonly endpoints: FeishuEndpoints
  private readonly fetcher: typeof fetch

  constructor(endpoints: FeishuEndpoints, fetcher: typeof fetch = fetch) {
    this.endpoints = endpoints
    this.fetcher = fetcher
  }

  private async post(
    path: string,
    body: Record<string, string>,
    options: { json?: boolean; basic?: string } = {},
  ): Promise<{ status: number; body: Json }> {
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.endpoints.accounts), {
        method: 'POST',
        headers: {
          'content-type': options.json
            ? 'application/json; charset=utf-8'
            : 'application/x-www-form-urlencoded',
          ...(options.basic ? { authorization: `Basic ${options.basic}` } : {}),
        },
        body: options.json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new FeishuOAuthError('network')
    }
    let parsed: unknown = {}
    try {
      parsed = JSON.parse(await response.text())
    } catch {
      // 非 JSON 当空体
    }
    const json =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Json) : {}
    return { status: response.status, body: json }
  }

  /** 申请设备码：拿到给本人点的链接和用户码 */
  async authorize(appId: string, secret: string, scopes: string[]): Promise<DeviceAuthorization> {
    const basic = Buffer.from(`${appId}:${secret}`).toString('base64')
    const { status, body } = await this.post(
      '/oauth/v1/device_authorization',
      { client_id: appId, scope: [...scopes, 'offline_access'].join(' ') },
      { basic },
    )
    const deviceCode = text(body.device_code)
    const userCode = text(body.user_code)
    const verificationUrl = text(body.verification_uri_complete) || text(body.verification_uri)
    if (status >= 400 || body.error || !deviceCode || !userCode || !verificationUrl)
      throw new FeishuOAuthError(
        status >= 500 ? 'network' : 'authorize_failed',
        text(body.error_description) || text(body.error),
      )
    return {
      deviceCode,
      userCode,
      verificationUrl,
      expiresIn: positive(body.expires_in, 240),
      interval: positive(body.interval, 5),
    }
  }

  /** 轮询一次：本人点了同意就拿到 token */
  async poll(appId: string, secret: string, deviceCode: string): Promise<PollResult> {
    const { status, body } = await this.post('/oauth/v3/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: appId,
      client_secret: secret,
    })
    const error = text(body.error)
    if (!error && text(body.access_token)) return { state: 'granted', tokens: tokens(body) }
    if (error === 'authorization_pending') return { state: 'pending' }
    if (error === 'slow_down') return { state: 'pending', slowDown: true }
    if (error === 'access_denied') return { state: 'denied' }
    if (!error && status >= 500) throw new FeishuOAuthError('network')
    return { state: 'expired' }
  }

  /** 刷新：refresh token 每用一次就换新，没给新的就沿用旧的 */
  async refresh(appId: string, secret: string, refreshToken: string): Promise<UserTokens> {
    const { status, body } = await this.post(
      '/oauth/v3/token',
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: appId,
        client_secret: secret,
      },
      { json: true },
    )
    if (status >= 500 && !body.error && body.code === undefined)
      throw new FeishuOAuthError('network')
    const code = typeof body.code === 'number' ? body.code : 0
    if (code !== 0 || body.error || !text(body.access_token))
      throw new FeishuOAuthError(
        'refresh_rejected',
        text(body.error_description) || text(body.error) || String(code),
      )
    const next = tokens(body)
    return { ...next, refreshToken: next.refreshToken || refreshToken }
  }

  /** 撤销 token（尽力而为，调用方不管失败） */
  async revoke(appId: string, secret: string, token: string, hint: string): Promise<void> {
    await this.post('/oauth/v1/revoke', {
      client_id: appId,
      client_secret: secret,
      token,
      token_type_hint: hint,
    })
  }

  /** 用用户 token 查是谁（核对授权的是不是被邀请的那个人） */
  async whoami(accessToken: string): Promise<{ openId: string; name: string }> {
    let response: Response
    try {
      response = await this.fetcher(
        new URL('/open-apis/authen/v1/user_info', this.endpoints.open),
        {
          headers: { authorization: `Bearer ${accessToken}` },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        },
      )
    } catch {
      throw new FeishuOAuthError('network')
    }
    let body: Json = {}
    try {
      body = JSON.parse(await response.text()) as Json
    } catch {
      // 落到下面的检查
    }
    const data = (body.data ?? {}) as Json
    const openId = text(data.open_id)
    if (body.code !== 0 || !openId) throw new FeishuOAuthError('whoami_failed')
    return { openId, name: text(data.name) }
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

function tokens(body: Json): UserTokens {
  return {
    accessToken: text(body.access_token),
    refreshToken: text(body.refresh_token),
    expiresIn: positive(body.expires_in, 7200),
    refreshExpiresIn: positive(body.refresh_token_expires_in, 604_800),
    scopes: text(body.scope).split(/\s+/).filter(Boolean),
  }
}
