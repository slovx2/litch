import {
  DEVICE_AUTOSTART_CHANGED,
  DEVICE_AUTOSTART_METHOD,
  type DeviceAutostartStatus,
  isDeviceAutostartMutationParams,
} from '../../../protocol/src/device-autostart.mjs'
import {
  EXTERNAL_METHOD,
  EXTERNAL_NOTIFICATION,
  type ExternalAccess,
  type ExternalConfiguration,
  type ExternalIdentityLogin,
  type ExternalInboxEvent,
  type ExternalOutboxSummary,
  type ExternalOwner,
  type ExternalSourceStatus,
} from '../../../protocol/src/external-sources.mjs'
import {
  isExternalMethod,
  isExternalMethodParams,
} from '../../../protocol/src/external-validation.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import { phrase } from '../phrase.mjs'
import {
  EXTERNAL_COMMAND,
  type ExternalCommandName,
  type ExternalDeviceTopic,
  type ExternalInboxFilter,
  type ExternalInboxView,
  type ExternalOutboxFilter,
  type ExternalWireRequests,
  externalFilterKey,
} from '../projection/external.mjs'
import { ExternalPages, ExternalRead, type ExternalReadHost } from './external-pages.mjs'

interface ExternalHost extends ExternalReadHost {
  sourcesSupported(): boolean
  autostartSupported(): boolean
  request<M extends keyof ExternalWireRequests>(
    method: M,
    params: ExternalWireRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ExternalWireRequests[M]['result']>
}

/** 设备回话是 JSON 值，按解码后的文本检测误回显。 */
function containsToken(value: unknown, token: string): boolean {
  if (typeof value === 'string') return value.includes(token)
  if (Array.isArray(value)) return value.some((item) => containsToken(item, token))
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.entries(value).some(([key, item]) => key.includes(token) || containsToken(item, token))
  )
}

export function createExternalDevice(host: ExternalHost) {
  const { sourcesSupported, autostartSupported } = host
  const logins = new Map<string, ExternalRead<ExternalIdentityLogin>>()
  function loginOf(loginId: string) {
    const found = logins.get(loginId)
    if (found) return found
    if (logins.size >= 16) {
      const old = [...logins].find(([, read]) => read.sinks.size === 0)
      if (old) logins.delete(old[0])
    }
    const read: ExternalRead<ExternalIdentityLogin> = new ExternalRead(
      host,
      sourcesSupported,
      () => host.request(EXTERNAL_METHOD.identityLoginGet, { loginId }),
      () => read.send(),
    )
    logins.set(loginId, read)
    return read
  }
  const deviceSinks = new Set<HostSink>()
  const inboxes = new Map<
    string,
    { filter: ExternalInboxFilter; page: ExternalPages<ExternalInboxEvent> }
  >()
  const outboxes = new Map<
    string,
    { filter: ExternalOutboxFilter; page: ExternalPages<ExternalOutboxSummary> }
  >()
  const readOwner = () => host.request(EXTERNAL_METHOD.ownerGet, {}).then((value) => value.owner)
  const readSources = () =>
    host.request(EXTERNAL_METHOD.sourceList, {}).then((value) => value.sources)
  const configuration = new ExternalRead<ExternalConfiguration>(
    host,
    sourcesSupported,
    () => host.request(EXTERNAL_METHOD.configurationGet, {}),
    publish,
  )
  const readAutostart = () => host.request(DEVICE_AUTOSTART_METHOD.get, {})
  const owner = new ExternalRead<ExternalOwner>(host, sourcesSupported, readOwner, publish)
  const sources = new ExternalRead<ExternalSourceStatus[]>(
    host,
    sourcesSupported,
    readSources,
    publish,
  )
  const autostart = new ExternalRead<DeviceAutostartStatus>(
    host,
    autostartSupported,
    readAutostart,
    publish,
  )
  const access = new ExternalRead<ExternalAccess>(
    host,
    sourcesSupported,
    async () => {
      const result = await host.request(EXTERNAL_METHOD.accessGet, {})
      return (
        result && {
          configure: result.configure === true,
          configureAutostart: result.configureAutostart === true,
          pauseSource: result.pauseSource === true,
          resumeSource: result.resumeSource === true,
          triageInbox: result.triageInbox === true,
          reassignInbox: result.reassignInbox === true,
        }
      )
    },
    () => {
      publish()
      for (const { page } of inboxes.values()) page.read.send()
    },
  )

  function projectedAccess() {
    if (!host.online() || !sourcesSupported() || !access.value) return {}
    return { access: access.value }
  }

  function watchingAccess() {
    return deviceSinks.size > 0 || [...inboxes.values()].some(({ page }) => page.read.sinks.size)
  }

  function resetAccess() {
    // 权限不能沿用上一条连接，连线和权限变更时一律先回到只读。
    access.value = null
    access.fetchedAt = null
    access.connectionChanged()
  }

  function snapshot() {
    return {
      owner: owner.snapshot(),
      sources: sources.snapshot(),
      autostart: autostart.snapshot(),
      configuration: configuration.snapshot(),
      ...projectedAccess(),
    }
  }

  function publish() {
    const value = snapshot()
    for (const sink of deviceSinks) sink.snapshot(value)
  }

  function pageFor<T extends { seq: number }, F extends ExternalInboxFilter | ExternalOutboxFilter>(
    list: Map<string, { filter: F; page: ExternalPages<T> }>,
    filter: F,
    create: () => ExternalPages<T>,
  ): ExternalPages<T> {
    const key = externalFilterKey(filter)
    const found = list.get(key)
    if (found) return found.page
    // 保留最近可看的快照，反复更换过滤项也不会无限增长。
    if (list.size >= 24) {
      const old = [...list].find(([, entry]) => entry.page.read.sinks.size === 0)
      if (old) list.delete(old[0])
    }
    const page = create()
    list.set(key, { filter, page })
    return page
  }

  const inbox = (filter: ExternalInboxFilter) =>
    pageFor(
      inboxes,
      filter,
      () =>
        new ExternalPages(host, sourcesSupported, (args) =>
          host.request(EXTERNAL_METHOD.inboxList, { ...filter, ...args }),
        ),
    )
  const outbox = (filter: ExternalOutboxFilter) =>
    pageFor(
      outboxes,
      filter,
      () =>
        new ExternalPages(host, sourcesSupported, (args) =>
          host.request(EXTERNAL_METHOD.outboxList, { ...filter, ...args }),
        ),
    )
  const deviceReads = [owner, sources, autostart, configuration] as const

  const refreshSources = () => {
    if (deviceSinks.size) void sources.refresh()
  }
  const refreshAutostart = () => {
    if (deviceSinks.size) void autostart.refresh()
  }
  const refreshOwner = () => {
    if (deviceSinks.size) void owner.refresh()
  }

  function refreshPages(
    list: Iterable<{
      filter: { sourceId?: string; managerId?: string }
      page: {
        read: { notify(): void }
      }
    }>,
    scope: { sourceId?: string; managerId?: string },
  ) {
    for (const { filter, page } of list) {
      if (scope.sourceId && filter.sourceId && scope.sourceId !== filter.sourceId) continue
      if (scope.managerId && filter.managerId && scope.managerId !== filter.managerId) continue
      page.read.notify()
    }
  }

  function connectionChanged() {
    resetAccess()
    if (watchingAccess()) void access.refresh()
    for (const read of deviceReads) {
      read.connectionChanged()
      if (deviceSinks.size) void read.refresh()
    }
    for (const read of logins.values()) {
      read.connectionChanged()
      read.notify()
    }
    for (const { page } of [...inboxes.values(), ...outboxes.values()]) {
      page.read.connectionChanged()
      page.read.notify()
    }
  }

  async function command(name: ExternalCommandName, args: unknown, signal?: AbortSignalLike) {
    const method = EXTERNAL_COMMAND[name]
    const supported = isExternalMethod(method) ? sourcesSupported() : autostartSupported()
    if (!host.online())
      throw new ChannelError('offline', 'Device is offline', phrase('external.offline'))
    if (!supported)
      throw new ChannelError(
        'unsupported',
        'External device capability is unavailable',
        phrase('external.unsupported'),
      )
    const valid = isExternalMethod(method)
      ? isExternalMethodParams(method, args)
      : method === DEVICE_AUTOSTART_METHOD.get
        ? Boolean(args && typeof args === 'object' && Object.keys(args).length === 0)
        : isDeviceAutostartMutationParams(method, args)
    if (!valid)
      throw new ChannelError('invalid', 'Invalid external request', phrase('external.invalid'))
    const sensitive = Object.hasOwn(args as object, 'token')
    try {
      const result = await host.request(
        method,
        args as ExternalWireRequests[typeof method]['params'],
        {
          ...(signal ? { signal } : {}),
          ...(sensitive ? { sensitive: true } : {}),
        },
      )
      if (sensitive) {
        const token = (args as { token: string }).token
        if (containsToken(result, token))
          throw new ChannelError('remote', 'Device returned invalid credential data')
      }
      switch (name) {
        case 'external.identity.login.cancel':
        case 'external.identity.login.confirm':
        case 'external.identity.import':
        case 'external.identity.paste':
          if ('loginId' in result && typeof result.loginId === 'string')
            logins.get(result.loginId)?.notify()
          if (deviceSinks.size) void configuration.refresh()
          break
        case 'external.identity.rotate':
        case 'external.identity.revoke':
        case 'external.manager.assignment.set':
          if (deviceSinks.size) void configuration.refresh()
          refreshSources()
          break
        case 'external.owner.set':
          refreshOwner()
          break
        case 'external.source.pause':
        case 'external.source.resume':
        case 'external.source.upsert':
          if (deviceSinks.size) void configuration.refresh()
          refreshSources()
          break
        case 'external.source.check':
          refreshSources()
          break
        case 'external.autostart.enable':
        case 'external.autostart.disable':
          if ('state' in result && result.state === 'completed') refreshAutostart()
          break
        case 'external.inbox.triage':
          // 改派同时影响原经理和新经理，也可能改落在几个状态页。
          refreshPages(inboxes.values(), {})
          refreshSources()
          break
      }
      return result
    } catch (error) {
      const failure = host.fail(error)
      if (!sensitive) throw failure
      // 凭据类远端错误正文可能复述请求；只让稳定类别穿过通道。
      throw new ChannelError(
        failure.code,
        'Credential operation failed',
        phrase('external.secretFailed'),
      )
    }
  }

  async function more<T extends { seq: number }>(page: ExternalPages<T>): Promise<void> {
    if (!host.online())
      throw new ChannelError('offline', 'Device is offline', phrase('external.offline'))
    if (!sourcesSupported())
      throw new ChannelError(
        'unsupported',
        'External sources are unavailable',
        phrase('external.unsupported'),
      )
    await page.more()
  }

  return {
    open(topic: ExternalDeviceTopic, sink: HostSink): () => void {
      if (topic.kind === 'externalIdentityLogin') return loginOf(topic.loginId).open(sink)
      if (topic.kind === 'externalOutbox') return outbox(topic.filter).read.open(sink)
      const startAccess = !watchingAccess()
      if (topic.kind === 'externalInbox') {
        const close = inbox(topic.filter).read.open({
          ...sink,
          snapshot: (value) =>
            sink.snapshot({ ...(value as ExternalInboxView), ...projectedAccess() }),
        })
        if (startAccess) void access.refresh()
        return () => {
          close()
          if (!watchingAccess()) resetAccess()
        }
      }
      const first = deviceSinks.size === 0
      deviceSinks.add(sink)
      sink.snapshot(snapshot())
      if (first) for (const read of deviceReads) void read.refresh()
      if (startAccess) void access.refresh()
      return () => {
        deviceSinks.delete(sink)
        if (!watchingAccess()) resetAccess()
      }
    },
    inboxMore: (filter: ExternalInboxFilter) => more(inbox(filter)),
    outboxMore: (filter: ExternalOutboxFilter) => more(outbox(filter)),
    command,
    connectionChanged,
    notification(method: string, params: unknown): boolean {
      const scope =
        params && typeof params === 'object'
          ? (params as {
              sourceId?: string
              managerId?: string
            })
          : {}
      switch (method) {
        case EXTERNAL_NOTIFICATION.accessChanged:
          resetAccess()
          if (watchingAccess()) void access.refresh()
          return true
        case EXTERNAL_NOTIFICATION.identityLoginChanged:
          if (
            params &&
            typeof params === 'object' &&
            'loginId' in params &&
            typeof params.loginId === 'string'
          )
            logins.get(params.loginId)?.notify()
          return true
        case EXTERNAL_NOTIFICATION.configurationChanged:
          if (deviceSinks.size) void configuration.refresh()
          refreshSources()
          return true
        case EXTERNAL_NOTIFICATION.ownerChanged:
          refreshOwner()
          return true
        case EXTERNAL_NOTIFICATION.sourcesChanged:
          refreshSources()
          return true
        case EXTERNAL_NOTIFICATION.inboxChanged:
          refreshPages(inboxes.values(), scope)
          refreshSources()
          return true
        case EXTERNAL_NOTIFICATION.outboxChanged:
          refreshPages(outboxes.values(), scope)
          return true
        case DEVICE_AUTOSTART_CHANGED:
          refreshAutostart()
          return true
        default:
          return false
      }
    },
  }
}
export type ExternalDevice = ReturnType<typeof createExternalDevice>
