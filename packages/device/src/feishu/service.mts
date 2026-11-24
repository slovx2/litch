// 设备的飞书来源：管全部应用的凭据、长连接和配置。随设备进程启动，客户端断开照常运行。
import {
  FEISHU_APP_ID,
  FEISHU_NOTIFICATION,
  type FeishuApp,
  type FeishuAppUpdateParams,
  type FeishuConnection,
  type FeishuRegistration,
} from '../../../protocol/src/feishu.mjs'
import { ProtocolError } from '../../../shared/src/protocol-contract.mjs'
import { type ManagerStore, managerNow } from '../manager-store.mjs'
import {
  FEISHU_PRODUCTION,
  FeishuApi,
  FeishuApiError,
  type FeishuEndpoints,
  feishuEndpointsForLoopbackTest,
} from './api.mjs'
import { checkCapability, upgradeCapability } from './capability.mjs'
import { FeishuConnectionRunner, type FeishuEventHandler } from './connection.mjs'
import { FeishuCredentials } from './credentials.mjs'
import { FeishuRegistrations } from './registration.mjs'
import { type FeishuAppRecord, FeishuStore } from './store.mjs'

export interface DeviceFeishuOptions {
  stateDirectory: string
  managers: ManagerStore
  announce: (method: string, params: unknown) => void
  log: (message: string) => void
  /** 测试：飞书地址换成回环假服务端，时间可控（秒） */
  fixture?: {
    origin: string
    now?: () => number
    watchdog?: ConstructorParameters<typeof FeishuConnectionRunner>[0]['watchdog']
    registrationIntervalMs?: number
  }
}

/** 入参不对或状态不允许：消息就是给客户端认的原因代码 */
export class FeishuInputError extends ProtocolError {
  constructor(reason: string) {
    super(-32602, reason)
  }
}

const fail = (reason: string): never => {
  throw new FeishuInputError(reason)
}

interface Running {
  api: FeishuApi
  connection: FeishuConnectionRunner
  generation: number
}

export class DeviceFeishuService {
  readonly store: FeishuStore
  readonly options: DeviceFeishuOptions
  private readonly credentials: FeishuCredentials
  private readonly endpoints: FeishuEndpoints
  private readonly registrations: FeishuRegistrations
  private readonly now: () => number
  private readonly running = new Map<string, Running>()
  /** 每个应用的连接状态（运行时，不进库） */
  private readonly connections = new Map<string, FeishuConnection>()
  /** 每个应用连上后要做的事（补缺口等，后续里程碑挂进来） */
  private readonly connectedHooks: ((appId: string) => void)[] = []
  private readonly handlers: Record<
    string,
    (appId: string, data: Record<string, unknown>) => Promise<unknown> | unknown
  > = {}
  private started = false

  constructor(options: DeviceFeishuOptions) {
    this.options = options
    this.store = new FeishuStore(options.managers)
    this.credentials = new FeishuCredentials(options.stateDirectory)
    this.endpoints = options.fixture
      ? feishuEndpointsForLoopbackTest(options.fixture.origin)
      : FEISHU_PRODUCTION
    this.now = options.fixture?.now ?? managerNow
    this.registrations = new FeishuRegistrations({
      endpoints: this.endpoints,
      now: this.now,
      changed: (registration) =>
        options.announce(FEISHU_NOTIFICATION.registrationChanged, {
          registrationId: registration.registrationId,
          revision: registration.revision,
        }),
      complete: async (result) => {
        const app = await this.add(result.appId, result.appSecret, {
          ...(result.creatorOpenId ? { creatorOpenId: result.creatorOpenId } : {}),
        })
        return { appId: app.appId }
      },
      ...(options.fixture?.registrationIntervalMs === undefined
        ? {}
        : { minIntervalMs: options.fixture.registrationIntervalMs }),
    })
  }

  /** 注册一种事件的处理函数（各里程碑的模块在启动前挂进来） */
  on(
    eventType: string,
    handler: (appId: string, data: Record<string, unknown>) => Promise<unknown> | unknown,
  ): void {
    this.handlers[eventType] = handler
  }

  onConnected(hook: (appId: string) => void): void {
    this.connectedHooks.push(hook)
  }

  start(): void {
    if (this.started) return
    this.started = true
    const apps = this.store.apps()
    this.credentials.sweep(new Map(apps.map((app) => [app.appId, app.credential.generation])))
    for (const app of apps) this.reconcile(app.appId)
  }

  close(): void {
    this.started = false
    this.registrations.close()
    for (const appId of [...this.running.keys()]) this.stop(appId)
  }

  /** 应用当前能用的 REST 客户端；停用或没凭据时为空 */
  api(appId: string): FeishuApi | null {
    return this.running.get(appId)?.api ?? null
  }

  apps(): FeishuApp[] {
    return this.store.apps().map((app) => this.view(app))
  }

  app(appId: string): FeishuApp {
    const app = this.store.app(appId) ?? fail('feishu_app_not_found')
    return this.view(app)
  }

  appForManager(managerId: string): FeishuAppRecord | null {
    return this.store.appForManager(managerId)
  }

  private view(app: FeishuAppRecord): FeishuApp {
    const connection = this.connections.get(app.appId) ?? {
      state: 'stopped' as const,
      since: app.createdAt,
      reconnects: 0,
    }
    return { ...app, connection }
  }

  private changed(appId?: string): void {
    this.options.announce(FEISHU_NOTIFICATION.appsChanged, appId ? { appId } : {})
  }

  // —— 创建向导 ——

  async registerBegin(name: string, operationId: string): Promise<FeishuRegistration> {
    try {
      return await this.registrations.begin(name, operationId)
    } catch {
      return fail('feishu_registration_unavailable')
    }
  }

  registerGet(registrationId: string): FeishuRegistration {
    return this.registrations.get(registrationId) ?? fail('feishu_registration_not_found')
  }

  registerCancel(registrationId: string): FeishuRegistration {
    return this.registrations.cancel(registrationId) ?? fail('feishu_registration_not_found')
  }

  // —— 应用 ——

  /** 校验凭据并读机器人信息；令牌被拒、没开机器人能力都报出来 */
  private async probe(appId: string, appSecret: string) {
    const api = new FeishuApi(this.endpoints, appId, () => appSecret)
    try {
      const body = await api.call('GET', '/open-apis/bot/v3/info')
      const bot = (body.bot ?? {}) as Record<string, unknown>
      const openId = typeof bot.open_id === 'string' ? bot.open_id : ''
      if (!openId) fail('feishu_bot_disabled')
      return {
        botOpenId: openId,
        name: typeof bot.app_name === 'string' ? bot.app_name.slice(0, 256) : '',
        ...(typeof bot.avatar_url === 'string' && /^https:\/\//.test(bot.avatar_url)
          ? { avatar: bot.avatar_url.slice(0, 2048) }
          : {}),
      }
    } catch (error) {
      if (error instanceof FeishuInputError) throw error
      if (error instanceof FeishuApiError && error.kind === 'credential_rejected')
        fail('feishu_credential_rejected')
      if (error instanceof FeishuApiError && error.kind === 'network') fail('feishu_unreachable')
      return fail('feishu_bot_disabled')
    }
  }

  private async add(
    appId: string,
    appSecret: string,
    extra: { creatorOpenId?: string } = {},
  ): Promise<FeishuApp> {
    if (!FEISHU_APP_ID.test(appId)) fail('feishu_app_id_invalid')
    if (this.store.app(appId)) throw new Error('feishu_app_exists')
    const bot = await this.probe(appId, appSecret)
    const now = this.now()
    this.credentials.write(appId, 1, appSecret)
    const record: FeishuAppRecord = {
      appId,
      revision: 1,
      ...bot,
      managerId: null,
      enabled: true,
      credential: { generation: 1, updatedAt: now },
      capability: null,
      ...extra,
      createdAt: now,
    }
    this.store.transaction(() => {
      if (this.store.app(appId)) throw new Error('feishu_app_exists')
      this.store.saveApp(record)
      this.store.audit(appId, now, {
        action: 'app_added',
        by: extra.creatorOpenId ? 'device' : 'admin',
      })
    })
    this.reconcile(appId)
    this.changed(appId)
    void this.check(appId).catch(() => undefined)
    return this.view(record)
  }

  async configure(appId: string, appSecret: string, operationId: string): Promise<FeishuApp> {
    const done = this.store.operation<{ appId: string }>('configure', operationId)
    if (done) return this.app(done.appId)
    try {
      const app = await this.add(appId, appSecret)
      this.store.saveOperation('configure', operationId, { appId })
      return app
    } catch (error) {
      if ((error as Error).message === 'feishu_app_exists') fail('feishu_app_exists')
      throw error
    }
  }

  async rotate(
    appId: string,
    appSecret: string,
    expectedGeneration: number,
    operationId: string,
  ): Promise<FeishuApp> {
    const done = this.store.operation<{ appId: string }>('rotate', operationId)
    if (done) return this.app(done.appId)
    const app = this.store.app(appId) ?? fail('feishu_app_not_found')
    if (app.credential.generation !== expectedGeneration) fail('feishu_revision_conflict')
    const bot = await this.probe(appId, appSecret)
    const now = this.now()
    const generation = app.credential.generation + 1
    this.credentials.write(appId, generation, appSecret)
    const next = this.store.transaction(() => {
      const current = this.store.app(appId) ?? fail('feishu_app_not_found')
      if (current.credential.generation !== expectedGeneration) fail('feishu_revision_conflict')
      const updated: FeishuAppRecord = {
        ...current,
        ...bot,
        revision: current.revision + 1,
        credential: { generation, updatedAt: now },
      }
      this.store.saveApp(updated)
      this.store.saveOperation('rotate', operationId, { appId })
      this.store.audit(appId, now, { action: 'app_rotated', by: 'admin', detail: { generation } })
      return updated
    })
    this.credentials.prune(appId, generation)
    this.stop(appId)
    this.reconcile(appId)
    this.changed(appId)
    return this.view(next)
  }

  update(params: FeishuAppUpdateParams): FeishuApp {
    const now = this.now()
    const next = this.store.transaction(() => {
      const app = this.store.app(params.appId) ?? fail('feishu_app_not_found')
      if (app.revision !== params.expectedRevision) fail('feishu_revision_conflict')
      const updated: FeishuAppRecord = { ...app, revision: app.revision + 1 }
      if (params.managerId !== undefined) {
        if (params.managerId !== null) {
          if (!this.store.managers.manager(params.managerId)) fail('feishu_manager_not_found')
          const other = this.store.appForManager(params.managerId)
          if (other && other.appId !== app.appId) fail('feishu_manager_taken')
        }
        updated.managerId = params.managerId
      }
      if (params.enabled !== undefined) updated.enabled = params.enabled
      this.store.saveApp(updated)
      this.store.audit(app.appId, now, {
        action: 'app_updated',
        by: 'admin',
        detail: {
          ...(params.managerId === undefined ? {} : { managerId: params.managerId }),
          ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
        },
      })
      return updated
    })
    this.reconcile(next.appId)
    this.changed(next.appId)
    return this.view(next)
  }

  remove(appId: string, expectedRevision: number): void {
    const now = this.now()
    this.store.transaction(() => {
      const app = this.store.app(appId) ?? fail('feishu_app_not_found')
      if (app.revision !== expectedRevision) fail('feishu_revision_conflict')
      this.store.removeApp(appId)
      this.store.audit(appId, now, { action: 'app_removed', by: 'admin' })
    })
    this.stop(appId)
    this.connections.delete(appId)
    this.credentials.prune(appId)
    this.changed(appId)
  }

  async check(appId: string): Promise<FeishuApp> {
    const api = this.api(appId) ?? fail('feishu_app_inactive')
    const before = this.store.app(appId) ?? fail('feishu_app_not_found')
    const capability = await checkCapability(api, this.now(), before.capability)
    return this.saveCapability(appId, capability)
  }

  async upgrade(appId: string, operationId: string): Promise<FeishuApp> {
    const done = this.store.operation<{ appId: string }>('upgrade', operationId)
    if (done) return this.app(done.appId)
    const api = this.api(appId) ?? fail('feishu_app_inactive')
    const before = this.store.app(appId) ?? fail('feishu_app_not_found')
    let capability: Awaited<ReturnType<typeof upgradeCapability>>
    try {
      capability = await upgradeCapability(api, this.now(), before.capability)
    } catch (error) {
      if (error instanceof FeishuApiError && error.kind === 'permission')
        fail('feishu_upgrade_forbidden')
      return fail('feishu_upgrade_failed')
    }
    const app = this.saveCapability(appId, capability, capability.publish ? operationId : undefined)
    return app
  }

  private saveCapability(
    appId: string,
    capability: FeishuAppRecord['capability'],
    operationId?: string,
  ): FeishuApp {
    const now = this.now()
    const next = this.store.transaction(() => {
      const app = this.store.app(appId) ?? fail('feishu_app_not_found')
      // 自检结果不是用户改的配置，不升版本号，免得和正在进行的修改冲突
      const updated = { ...app, capability }
      this.store.saveApp(updated)
      if (operationId) {
        this.store.saveOperation('upgrade', operationId, { appId })
        this.store.audit(appId, now, {
          action: 'app_upgrade_submitted',
          by: 'admin',
          detail: { versionId: capability?.publish?.versionId ?? null },
        })
      }
      return updated
    })
    this.changed(appId)
    return this.view(next)
  }

  // —— 连接 ——

  /** 按库里的配置起停连接：启用、有凭据就连；凭据换了代就重连 */
  private reconcile(appId: string): void {
    if (!this.started) return
    const app = this.store.app(appId)
    const running = this.running.get(appId)
    if (!app?.enabled) {
      if (running) this.stop(appId)
      return
    }
    if (running && running.generation === app.credential.generation) return
    if (running) this.stop(appId)
    const secret = this.credentials.read(appId, app.credential.generation)
    if (secret === null) {
      this.connections.set(appId, {
        state: 'failed',
        since: this.now(),
        reconnects: 0,
        error: { code: 'credential_rejected', at: this.now() },
      })
      return
    }
    const api = new FeishuApi(this.endpoints, appId, () => secret)
    const handlers: Record<string, FeishuEventHandler> = {}
    for (const [type, handler] of Object.entries(this.handlers))
      handlers[type] = (data) => handler(appId, data)
    const connection = new FeishuConnectionRunner({
      appId,
      secret: () => secret,
      domain: this.endpoints.open,
      handlers,
      changed: (state) => {
        const previous = this.connections.get(appId)
        this.connections.set(appId, state)
        // lastEventAt 每条事件都会变，只在连接状态或错误变化时通知
        if (previous?.state !== state.state || previous?.error?.code !== state.error?.code)
          this.changed(appId)
      },
      connected: () => {
        for (const hook of this.connectedHooks) {
          try {
            hook(appId)
          } catch (error) {
            this.options.log(`飞书连上后的处理出错：${(error as Error).message}`)
          }
        }
      },
      log: this.options.log,
      now: () => Date.now(),
      ...(this.options.fixture?.watchdog ? { watchdog: this.options.fixture.watchdog } : {}),
    })
    this.running.set(appId, { api, connection, generation: app.credential.generation })
    connection.start()
  }

  private stop(appId: string): void {
    const running = this.running.get(appId)
    if (!running) return
    this.running.delete(appId)
    running.connection.close()
  }
}
