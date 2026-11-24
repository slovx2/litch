// 用户身份授权：只有本应用已绑定的人能授权，必须本人在飞书里点同意。
// 设备码流程拿到链接和用户码，交给人转给本人；轮询拿到 token 后先查是谁，不是被邀请的那个人就作废。
// token 存设备私有目录（每次刷新换一代，旧代删掉），库里只放元数据；token 不进租约、环境变量、日志。
// access token 过期前 5 分钟刷新（同一个人串行）；后台每 6 天续一次期，连续 30 天没用就失效；刷新被拒就失效，不回退机器人。
import { join } from 'node:path'
import type { FeishuGrantState, FeishuUserGrant } from '../../../protocol/src/feishu.mjs'
import { FEISHU_NOTIFICATION } from '../../../protocol/src/feishu.mjs'
import { ExternalPrivateFiles } from '../external/secrets-files.mjs'
import type { FeishuBindings } from './bindings.mjs'
import type { FeishuAuditAction, FeishuStore } from './store.mjs'
import { FEISHU_USER_SCOPES, type FeishuOAuth, FeishuOAuthError } from './user-oauth.mjs'

export const FEISHU_GRANTS_MIGRATION = `
CREATE TABLE feishu_user_grants(
  app_id TEXT NOT NULL, open_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(app_id, open_id)
);
`

/** token 文件放在设备状态目录下的这里（0700，文件 0600） */
export const FEISHU_USER_TOKENS_DIRECTORY = 'feishu-user-tokens'
const REFRESH_AHEAD = 300
const RENEW_EVERY = 6 * 86_400
const UNUSED_LIMIT = 30 * 86_400
const TICK_MS = 3600_000

interface GrantRecord extends Omit<FeishuUserGrant, 'pending'> {
  pending?: FeishuUserGrant['pending'] & { operationId: string }
  /** token 文件的代次；0 表示没有 token */
  generation: number
  accessExpiresAt?: number
  refreshExpiresAt?: number
}

export interface FeishuUserGrantsOptions {
  stateDirectory: string
  store: FeishuStore
  bindings: FeishuBindings
  oauth: FeishuOAuth
  /** 应用当前的 App Secret；没有凭据时为空 */
  secret: (appId: string) => string | null
  /** 应用已开的用户身份权限（能力自检）；不知道时为空，按全部清单申请 */
  enabledScopes: (appId: string) => string[] | null
  now: () => number
  announce: (method: string, params: unknown) => void
  fail: (reason: string) => never
  log: (message: string) => void
  /** 测试：轮询间隔（毫秒） */
  pollMs?: number
}

export class FeishuUserGrants {
  private readonly options: FeishuUserGrantsOptions
  private readonly files: ExternalPrivateFiles
  private readonly polls = new Map<string, AbortController>()
  private readonly serial = new Map<string, Promise<unknown>>()
  private timer: NodeJS.Timeout | null = null

  constructor(options: FeishuUserGrantsOptions) {
    this.options = options
    this.files = new ExternalPrivateFiles(
      join(options.stateDirectory, FEISHU_USER_TOKENS_DIRECTORY),
    )
  }

  private get db() {
    return this.options.store.managers.db
  }

  private record(appId: string, openId: string): GrantRecord | null {
    const row = this.db
      .prepare('SELECT body FROM feishu_user_grants WHERE app_id=? AND open_id=?')
      .get(appId, openId)
    return row ? (JSON.parse(String(row.body)) as GrantRecord) : null
  }

  private save(record: GrantRecord): GrantRecord {
    this.db
      .prepare(
        `INSERT INTO feishu_user_grants(app_id, open_id, body) VALUES(?,?,?)
         ON CONFLICT(app_id, open_id) DO UPDATE SET body=excluded.body`,
      )
      .run(record.appId, record.openId, JSON.stringify(record))
    this.options.announce(FEISHU_NOTIFICATION.grantsChanged, {
      appId: record.appId,
      openId: record.openId,
    })
    return record
  }

  private records(appId?: string): GrantRecord[] {
    return (
      appId
        ? this.db.prepare('SELECT body FROM feishu_user_grants WHERE app_id=?').all(appId)
        : this.db.prepare('SELECT body FROM feishu_user_grants').all()
    ).map((row) => JSON.parse(String(row.body)) as GrantRecord)
  }

  view(record: GrantRecord): FeishuUserGrant {
    const { generation: _g, accessExpiresAt: _a, refreshExpiresAt: _r, pending, ...grant } = record
    if (!pending) return grant
    const { operationId: _o, ...shown } = pending
    return { ...grant, pending: shown }
  }

  list(appId: string): FeishuUserGrant[] {
    return this.records(appId).map((record) => this.view(record))
  }

  get(appId: string, openId: string): FeishuUserGrant | null {
    const record = this.record(appId, openId)
    return record ? this.view(record) : null
  }

  /** 能用的授权（state=active） */
  active(appId: string, openId: string): FeishuUserGrant | null {
    const record = this.record(appId, openId)
    return record?.state === 'active' ? this.view(record) : null
  }

  private audit(appId: string, action: FeishuAuditAction, detail: Record<string, string>) {
    this.options.store.audit(appId, this.options.now(), { action, by: 'device', detail })
  }

  private tokenName = (record: { appId: string; openId: string }, generation: number) =>
    `${record.appId}-${record.openId}-${generation}`

  private readTokens(record: GrantRecord): { accessToken: string; refreshToken: string } | null {
    if (!record.generation) return null
    const text = this.files.read(this.tokenName(record, record.generation))
    if (!text) return null
    try {
      return JSON.parse(text) as { accessToken: string; refreshToken: string }
    } catch {
      return null
    }
  }

  /** 删掉这个人全部代次的 token 文件 */
  private dropTokens(record: { appId: string; openId: string }, keep?: number): void {
    const prefix = `${record.appId}-${record.openId}-`
    for (const name of this.files.keys())
      if (name.startsWith(prefix) && (keep === undefined || name !== `${prefix}${keep}`))
        this.files.remove(name)
  }

  // —— 发起授权 ——

  /** 发起（或重新发起）授权：作废这个人进行中的上一个，返回链接和用户码 */
  async invite(
    appId: string,
    openId: string,
    operationId: string,
    from: { via: 'admin' | 'manager_tool'; reason?: string } = { via: 'admin' },
  ): Promise<FeishuUserGrant> {
    const { fail } = this.options
    const binding = this.options.bindings.bound(appId, openId)
    if (!binding) fail('feishu_user_unbound')
    const existing = this.record(appId, openId)
    if (existing?.pending?.operationId === operationId) return this.view(existing)
    const secret = this.options.secret(appId) ?? fail('feishu_app_inactive')
    const enabled = this.options.enabledScopes(appId)
    const scopes = enabled
      ? FEISHU_USER_SCOPES.filter((one) => enabled.includes(one))
      : [...FEISHU_USER_SCOPES]
    if (scopes.length === 0) fail('feishu_user_scopes_missing')
    const key = `${appId}/${openId}`
    this.polls.get(key)?.abort()
    this.polls.delete(key)
    let authorization: Awaited<ReturnType<FeishuOAuth['authorize']>>
    try {
      authorization = await this.options.oauth.authorize(appId, secret, scopes)
    } catch (error) {
      return fail(`feishu_${error instanceof FeishuOAuthError ? error.code : 'authorize_failed'}`)
    }
    const now = this.options.now()
    const base: GrantRecord = existing ?? {
      appId,
      openId,
      revision: 0,
      name: binding?.name ?? '',
      state: 'pending',
      scopes: [],
      generation: 0,
    }
    const record = this.save({
      ...base,
      revision: base.revision + 1,
      name: binding?.name ?? base.name,
      state: base.state === 'active' ? 'active' : 'pending',
      pending: {
        verificationUrl: authorization.verificationUrl,
        userCode: authorization.userCode,
        expiresAt: now + authorization.expiresIn,
        operationId,
      },
    })
    this.audit(appId, 'grant_invited', {
      openId,
      via: from.via,
      ...(from.reason ? { reason: from.reason } : {}),
    })
    const controller = new AbortController()
    this.polls.set(key, controller)
    void this.pollLoop(record, authorization, secret, controller.signal)
      .catch((error: Error) => this.options.log(`飞书用户授权轮询出错：${error.message}`))
      .finally(() => {
        if (this.polls.get(key) === controller) this.polls.delete(key)
      })
    return this.view(record)
  }

  private async pollLoop(
    invited: GrantRecord,
    authorization: Awaited<ReturnType<FeishuOAuth['authorize']>>,
    secret: string,
    signal: AbortSignal,
  ): Promise<void> {
    let interval = authorization.interval
    const deadline = this.options.now() + authorization.expiresIn
    for (;;) {
      await wait(this.options.pollMs ?? interval * 1000, signal)
      if (signal.aborted) return
      if (this.options.now() > deadline) return this.settle(invited, 'failed', 'invite_expired')
      let result: Awaited<ReturnType<FeishuOAuth['poll']>>
      try {
        result = await this.options.oauth.poll(invited.appId, secret, authorization.deviceCode)
      } catch {
        interval = Math.min(60, interval + 1)
        continue
      }
      if (signal.aborted) return
      if (result.state === 'pending') {
        if (result.slowDown) interval = Math.min(60, interval + 5)
        continue
      }
      if (result.state === 'denied') return this.settle(invited, 'failed', 'denied')
      if (result.state === 'expired') return this.settle(invited, 'failed', 'invite_expired')
      return this.granted(invited, result.tokens, secret)
    }
  }

  /** 进行中的授权没成：原来有可用授权的保留，只清掉进行中的部分 */
  private settle(invited: GrantRecord, state: FeishuGrantState, error: string): void {
    const current = this.record(invited.appId, invited.openId)
    if (!current?.pending || current.pending.operationId !== invited.pending?.operationId) return
    const { pending: _pending, ...rest } = current
    this.save({
      ...rest,
      revision: current.revision + 1,
      ...(current.state === 'active' ? {} : { state }),
      error,
    })
    this.audit(invited.appId, 'grant_failed', { openId: invited.openId, error })
  }

  private async granted(
    invited: GrantRecord,
    tokens: Awaited<ReturnType<FeishuOAuth['refresh']>>,
    secret: string,
  ): Promise<void> {
    const { appId, openId } = invited
    const revoke = () => {
      void this.options.oauth
        .revoke(appId, secret, tokens.accessToken, 'access_token')
        .catch(() => {})
      if (tokens.refreshToken)
        void this.options.oauth
          .revoke(appId, secret, tokens.refreshToken, 'refresh_token')
          .catch(() => {})
    }
    let who: { openId: string }
    try {
      who = await this.options.oauth.whoami(tokens.accessToken)
    } catch {
      revoke()
      return this.settle(invited, 'failed', 'whoami_failed')
    }
    // 链接被转给了别人：作废，记审计
    if (who.openId !== openId) {
      revoke()
      this.audit(appId, 'grant_mismatch', { openId })
      return this.settle(invited, 'failed', 'identity_mismatch')
    }
    // 应用没开“刷新 user_access_token”：两小时后就得重新授权，不收这样的授权
    if (!tokens.refreshToken) {
      revoke()
      return this.settle(invited, 'failed', 'no_refresh_token')
    }
    const current = this.record(appId, openId)
    if (!current?.pending || current.pending.operationId !== invited.pending?.operationId) {
      revoke()
      return
    }
    if (!this.options.bindings.bound(appId, openId)) {
      revoke()
      return this.settle(invited, 'failed', 'user_unbound')
    }
    const now = this.options.now()
    const generation = current.generation + 1
    this.files.write(
      this.tokenName(current, generation),
      JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    )
    const { pending: _pending, error: _error, revokedAt: _revoked, ...rest } = current
    this.save({
      ...rest,
      revision: current.revision + 1,
      state: 'active',
      scopes: tokens.scopes,
      generation,
      grantedAt: now,
      refreshedAt: now,
      lastUsedAt: now,
      accessExpiresAt: now + tokens.expiresIn,
      refreshExpiresAt: now + tokens.refreshExpiresIn,
    })
    this.dropTokens(current, generation)
    this.audit(appId, 'grant_granted', { openId })
  }

  // —— 用 token ——

  /** 代理转发前取这个人的 access token：快过期就先刷新（同一个人串行）；没有可用授权时抛 FeishuOAuthError */
  token(appId: string, openId: string): Promise<string> {
    return this.queue(`${appId}/${openId}`, async () => {
      const record = this.record(appId, openId)
      if (record?.state !== 'active') throw new FeishuOAuthError('not_granted')
      const now = this.options.now()
      const fresh =
        (record.accessExpiresAt ?? 0) - now > REFRESH_AHEAD ? record : await this.refresh(record)
      const tokens = this.readTokens(fresh)
      if (!tokens) {
        this.expire(fresh, 'token_missing')
        throw new FeishuOAuthError('not_granted')
      }
      // 最近使用时间按分钟记，免得每个请求都写库
      if (now - (fresh.lastUsedAt ?? 0) >= 60)
        this.db
          .prepare('UPDATE feishu_user_grants SET body=? WHERE app_id=? AND open_id=?')
          .run(JSON.stringify({ ...fresh, lastUsedAt: now }), appId, openId)
      return tokens.accessToken
    })
  }

  private queue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(work)
    this.serial.set(key, next)
    void next
      .catch(() => {})
      .finally(() => {
        if (this.serial.get(key) === next) this.serial.delete(key)
      })
    return next
  }

  /** 刷新一次：换新一代 token 文件；被拒就失效 */
  private async refresh(record: GrantRecord): Promise<GrantRecord> {
    const tokens = this.readTokens(record)
    const secret = this.options.secret(record.appId)
    if (!tokens || !secret) {
      this.expire(record, tokens ? 'app_inactive' : 'token_missing')
      throw new FeishuOAuthError('not_granted')
    }
    let next: Awaited<ReturnType<FeishuOAuth['refresh']>>
    try {
      next = await this.options.oauth.refresh(record.appId, secret, tokens.refreshToken)
    } catch (error) {
      if (error instanceof FeishuOAuthError && error.code === 'refresh_rejected') {
        this.expire(record, 'refresh_rejected')
        this.audit(record.appId, 'grant_expired', {
          openId: record.openId,
          error: 'refresh_rejected',
        })
        throw new FeishuOAuthError('not_granted')
      }
      throw error
    }
    const now = this.options.now()
    const generation = record.generation + 1
    this.files.write(
      this.tokenName(record, generation),
      JSON.stringify({ accessToken: next.accessToken, refreshToken: next.refreshToken }),
    )
    const current = this.record(record.appId, record.openId) ?? record
    const saved = this.save({
      ...current,
      revision: current.revision + 1,
      generation,
      refreshedAt: now,
      accessExpiresAt: now + next.expiresIn,
      refreshExpiresAt: now + next.refreshExpiresIn,
      ...(next.scopes.length ? { scopes: next.scopes } : {}),
    })
    this.dropTokens(record, generation)
    return saved
  }

  private expire(record: GrantRecord, error: string): void {
    this.dropTokens(record)
    const current = this.record(record.appId, record.openId) ?? record
    this.save({
      ...current,
      revision: current.revision + 1,
      state: 'expired',
      generation: 0,
      error,
    })
  }

  // —— 撤销与后台 ——

  /** 撤销：先在飞书撤销 token（尽力而为），再删设备上的 token */
  revoke(appId: string, openId: string, reason: string): FeishuUserGrant | null {
    const record = this.record(appId, openId)
    if (!record) return null
    const key = `${appId}/${openId}`
    this.polls.get(key)?.abort()
    this.polls.delete(key)
    const tokens = this.readTokens(record)
    const secret = this.options.secret(appId)
    if (tokens && secret) {
      void this.options.oauth
        .revoke(appId, secret, tokens.accessToken, 'access_token')
        .catch(() => {})
      void this.options.oauth
        .revoke(appId, secret, tokens.refreshToken, 'refresh_token')
        .catch(() => {})
    }
    this.dropTokens(record)
    const { pending: _pending, ...rest } = record
    const saved = this.save({
      ...rest,
      revision: record.revision + 1,
      state: 'revoked',
      generation: 0,
      revokedAt: this.options.now(),
      error: reason,
    })
    this.audit(appId, 'grant_revoked', { openId, reason })
    return this.view(saved)
  }

  /** 移除应用：撤销全部授权，删掉记录 */
  removeApp(appId: string): void {
    for (const record of this.records(appId)) this.revoke(appId, record.openId, 'app_removed')
    this.db.prepare('DELETE FROM feishu_user_grants WHERE app_id=?').run(appId)
  }

  start(): void {
    // 设备码只在内存里：上次进行中的授权作废
    for (const record of this.records())
      if (record.pending) {
        const { pending: _pending, ...rest } = record
        this.save({
          ...rest,
          revision: record.revision + 1,
          ...(record.state === 'active' ? {} : { state: 'failed' as const }),
          error: 'invite_interrupted',
        })
      }
    void this.tick()
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref()
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const controller of this.polls.values()) controller.abort()
    this.polls.clear()
  }

  /** 后台：30 天没用的失效；6 天没刷新的续一次期（refresh token 7 天过期） */
  async tick(): Promise<void> {
    const now = this.options.now()
    for (const record of this.records()) {
      if (record.state !== 'active') continue
      if (now - (record.lastUsedAt ?? record.grantedAt ?? now) > UNUSED_LIMIT) {
        this.revoke(record.appId, record.openId, 'unused')
        continue
      }
      if (now - (record.refreshedAt ?? record.grantedAt ?? now) < RENEW_EVERY) continue
      await this.queue(`${record.appId}/${record.openId}`, async () => {
        const current = this.record(record.appId, record.openId)
        if (current?.state === 'active') await this.refresh(current)
      }).catch((error: Error) => this.options.log(`飞书用户授权续期失败：${error.message}`))
    }
  }

  /** 测试用：等进行中的轮询结束 */
  async idle(): Promise<void> {
    while (this.serial.size) await Promise.allSettled([...this.serial.values()])
  }

  /** 是否还有进行中的授权（测试用） */
  polling(appId: string, openId: string): boolean {
    return this.polls.has(`${appId}/${openId}`)
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
