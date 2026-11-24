// 飞书应用创建向导：设备注册流程（action=begin 拿创建页地址，再按 interval 轮询 action=poll 拿凭据）。
// device_code 只在内存里；设备重启后进行中的向导作废，用户重新点一次即可。
import { randomUUID } from 'node:crypto'
import type { FeishuRegistration } from '../../../protocol/src/feishu.mjs'
import type { FeishuEndpoints } from './api.mjs'
import { registrationAddons } from './permissions.mjs'

const REGISTRATION_PATH = '/oauth/v1/app/registration'
/** 每次向导最多等 600 秒 */
const MAX_WINDOW = 600

export interface FeishuRegistrationResult {
  appId: string
  appSecret: string
  name: string
  creatorOpenId?: string
}

export interface FeishuRegistrationHost {
  endpoints: FeishuEndpoints
  /** 秒 */
  now: () => number
  changed: (registration: FeishuRegistration) => void
  /** 拿到凭据后保存应用；失败时抛出，向导记为 error */
  complete: (result: FeishuRegistrationResult) => Promise<{ appId: string }>
  fetch?: typeof fetch
  /** 测试用：轮询间隔下限（毫秒） */
  minIntervalMs?: number
}

interface Pending {
  registration: FeishuRegistration
  deviceCode: string | null
  intervalSeconds: number
  timer: NodeJS.Timeout | null
}

export class FeishuRegistrations {
  private readonly host: FeishuRegistrationHost
  private readonly items = new Map<string, Pending>()
  private readonly operations = new Map<string, string>()

  constructor(host: FeishuRegistrationHost) {
    this.host = host
  }

  get(registrationId: string): FeishuRegistration | null {
    const item = this.items.get(registrationId)
    return item ? this.view(item) : null
  }

  async begin(name: string, operationId: string): Promise<FeishuRegistration> {
    const existing = this.operations.get(operationId)
    const known = existing ? this.items.get(existing) : undefined
    if (known) return this.view(known)
    const body = await this.post({
      action: 'begin',
      archetype: 'PersonalAgent',
      auth_method: 'client_secret',
      // 和官方 CLI 一样两样都要；返回在 user_info 里（2026-11-24 真实应用核实）
      request_user_info: 'open_id tenant_brand',
    })
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : ''
    const verification =
      typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : ''
    const url = deviceCode && verification ? creationUrl(verification, name.trim()) : null
    if (!url) throw new Error('feishu_registration_unavailable')
    const now = this.host.now()
    const expireIn = Math.min(MAX_WINDOW, Math.max(1, Number(body.expire_in) || MAX_WINDOW))
    const registration: FeishuRegistration = {
      registrationId: randomUUID(),
      revision: 1,
      state: 'waiting',
      name: name.trim(),
      url,
      expiresAt: now + expireIn,
    }
    const item: Pending = {
      registration,
      deviceCode,
      intervalSeconds: Math.max(1, Math.min(60, Number(body.interval) || 5)),
      timer: null,
    }
    this.items.set(registration.registrationId, item)
    this.operations.set(operationId, registration.registrationId)
    this.schedule(item)
    return this.view(item)
  }

  cancel(registrationId: string): FeishuRegistration | null {
    const item = this.items.get(registrationId)
    if (!item) return null
    if (item.registration.state === 'waiting') this.finish(item, { state: 'canceled' })
    return this.view(item)
  }

  close(): void {
    for (const item of this.items.values()) {
      if (item.timer) clearTimeout(item.timer)
      item.timer = null
      item.deviceCode = null
    }
  }

  private view(item: Pending): FeishuRegistration {
    const { url, ...rest } = item.registration
    return item.registration.state === 'waiting' && url ? { ...rest, url } : rest
  }

  private schedule(item: Pending): void {
    const delay = Math.max(this.host.minIntervalMs ?? 0, item.intervalSeconds * 1000)
    item.timer = setTimeout(() => {
      item.timer = null
      void this.poll(item)
    }, delay)
    item.timer.unref()
  }

  private finish(item: Pending, next: Partial<FeishuRegistration>): void {
    if (item.timer) clearTimeout(item.timer)
    item.timer = null
    item.deviceCode = null
    item.registration = { ...item.registration, ...next, revision: item.registration.revision + 1 }
    this.host.changed(this.view(item))
  }

  private async poll(item: Pending): Promise<void> {
    if (item.registration.state !== 'waiting' || !item.deviceCode) return
    if (this.host.now() >= item.registration.expiresAt)
      return this.finish(item, { state: 'expired' })
    let body: Record<string, unknown>
    try {
      body = await this.post({ action: 'poll', device_code: item.deviceCode, tp: 'ob_app' })
    } catch {
      body = { error: 'unavailable' }
    }
    // 网络回来时用户可能已经取消
    if (item.registration.state !== 'waiting') return
    const user = (body.user_info ?? {}) as Record<string, unknown>
    if (user.tenant_brand === 'lark')
      return this.finish(item, { state: 'error', error: 'lark_tenant' })
    const appId = typeof body.client_id === 'string' ? body.client_id : ''
    const appSecret = typeof body.client_secret === 'string' ? body.client_secret : ''
    if (appId && appSecret) {
      item.deviceCode = null
      const creator = typeof user.open_id === 'string' ? user.open_id : undefined
      try {
        const saved = await this.host.complete({
          appId,
          appSecret,
          name: item.registration.name,
          ...(creator ? { creatorOpenId: creator } : {}),
        })
        return this.finish(item, { state: 'succeeded', appId: saved.appId })
      } catch (error) {
        const reason =
          (error as Error).message === 'feishu_app_exists'
            ? 'already_configured'
            : 'credential_invalid'
        return this.finish(item, { state: 'error', error: reason })
      }
    }
    const error = typeof body.error === 'string' ? body.error : undefined
    if (error === 'expired_token' || error === 'invalid_grant')
      return this.finish(item, { state: 'expired' })
    if (error === 'access_denied') return this.finish(item, { state: 'denied' })
    if (error === 'slow_down' || error === 'unavailable')
      item.intervalSeconds = Math.min(60, item.intervalSeconds + 5)
    else if (error !== 'authorization_pending' && error !== undefined)
      return this.finish(item, { state: 'error', error: 'unavailable' })
    this.schedule(item)
  }

  private async post(form: Record<string, string>): Promise<Record<string, unknown>> {
    const fetcher = this.host.fetch ?? fetch
    const response = await fetcher(new URL(REGISTRATION_PATH, this.host.endpoints.accounts), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    // authorization_pending、slow_down 也可能以 HTTP 400 返回
    const text = await response.text()
    const value = JSON.parse(text.length > 1024 * 1024 ? '{}' : text || '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }
}

/** 在飞书给的创建页地址上附上机器人名和权限清单；只接受飞书的两个主机 */
export function creationUrl(verification: string, name: string): string | null {
  let url: URL
  try {
    url = new URL(verification)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || !['open.feishu.cn', 'accounts.feishu.cn'].includes(url.hostname))
    return null
  url.searchParams.set('from', 'sdk')
  url.searchParams.set('tp', 'sdk')
  url.searchParams.set('source', 'litch')
  url.searchParams.set('name', name)
  url.searchParams.set('addons', registrationAddons())
  url.searchParams.set('createOnly', 'true')
  return url.toString()
}
