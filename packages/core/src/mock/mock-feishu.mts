// 模拟核心里的飞书来源：每台在线设备一份应用列表，创建向导两秒后自动完成。样例全是虚构的名字和 ID。
import type { FeishuApp, FeishuRegistration } from '../../../protocol/src/feishu.mjs'
import { ChannelError, type Clock } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView } from '../model.mjs'
import { type FeishuTopic, isFeishuCommand } from '../projection/feishu.mjs'

const sampleApp = (now: number, managerId: string | null): FeishuApp => ({
  appId: 'cli_a1b2c3d4e5f60718',
  revision: 3,
  name: '示例助手',
  botOpenId: 'ou_mock_bot',
  managerId,
  enabled: true,
  credential: { generation: 1, updatedAt: now - 86_400 },
  connection: {
    state: 'connected',
    since: now - 3_600,
    lastConnectedAt: now - 3_600,
    lastEventAt: now - 120,
    reconnects: 1,
  },
  capability: {
    checkedAt: now - 600,
    state: 'missing',
    missingScopes: ['calendar:calendar'],
    missingEvents: [],
    missingCallbacks: [],
  },
  creatorOpenId: 'ou_mock_owner',
  createdAt: now - 86_400 * 3,
})

export function createMockFeishu(clock: Clock, devices: () => DeviceView[], filled: boolean) {
  const now = () => Math.floor(clock.now() / 1000)
  const states = new Map<string, ReturnType<typeof make>>()
  const online = (id: string) =>
    devices().some((device) => device.id === id && device.connection === 'online')

  function make(deviceId: string) {
    let apps: FeishuApp[] = filled && deviceId === 'local' ? [sampleApp(now(), 'm1')] : []
    const registrations = new Map<string, FeishuRegistration>()
    const sinks = new Set<HostSink>()
    const registrationSinks = new Map<string, Set<HostSink>>()
    const snapshot = () => ({
      apps: {
        available: true,
        online: online(deviceId),
        value: apps,
        fetchedAt: clock.now(),
        error: null,
      },
    })
    const publish = () => {
      for (const sink of sinks) sink.snapshot(snapshot())
    }
    const publishRegistration = (id: string) => {
      const value = registrations.get(id) ?? null
      for (const sink of registrationSinks.get(id) ?? [])
        sink.snapshot({ available: true, online: true, value, fetchedAt: clock.now(), error: null })
    }
    const find = (appId: string) =>
      apps.find((app) => app.appId === appId) ?? fail('feishu_app_not_found')
    const save = (app: FeishuApp) => {
      apps = apps.map((item) => (item.appId === app.appId ? app : item))
      publish()
      return { app }
    }
    const add = (appId: string, name: string) => {
      if (apps.some((app) => app.appId === appId)) fail('feishu_app_exists')
      const app: FeishuApp = {
        ...sampleApp(now(), null),
        appId,
        name,
        revision: 1,
        capability: null,
        connection: { state: 'connecting', since: now(), reconnects: 0 },
      }
      apps = [...apps, app]
      publish()
      clock.setTimer(() => {
        const current = apps.find((item) => item.appId === appId)
        if (current)
          save({
            ...current,
            connection: { state: 'connected', since: now(), lastConnectedAt: now(), reconnects: 0 },
          })
      }, 800)
      return { app }
    }
    return {
      open(topic: FeishuTopic, sink: HostSink) {
        if (topic.kind === 'feishuRegistration') {
          const set = registrationSinks.get(topic.registrationId) ?? new Set<HostSink>()
          registrationSinks.set(topic.registrationId, set)
          set.add(sink)
          publishRegistration(topic.registrationId)
          return () => set.delete(sink)
        }
        sinks.add(sink)
        sink.snapshot(snapshot())
        return () => sinks.delete(sink)
      },
      async command(name: string, args: Record<string, unknown>): Promise<unknown> {
        switch (name) {
          case 'feishu.app.get':
            return { app: find(String(args.appId)) }
          case 'feishu.app.register.begin': {
            const registrationId = `mock-reg-${registrations.size + 1}`
            const registration: FeishuRegistration = {
              registrationId,
              revision: 1,
              state: 'waiting',
              name: String(args.name),
              url: 'https://open.feishu.cn/page/launcher?mock=1',
              expiresAt: now() + 600,
            }
            registrations.set(registrationId, registration)
            clock.setTimer(() => {
              const current = registrations.get(registrationId)
              if (current?.state !== 'waiting') return
              const appId = `cli_${String(registrations.size).padStart(16, '0')}`
              try {
                add(appId, current.name)
                const { url: _url, ...rest } = current
                registrations.set(registrationId, {
                  ...rest,
                  revision: 2,
                  state: 'succeeded',
                  appId,
                })
              } catch {
                registrations.set(registrationId, {
                  ...current,
                  revision: 2,
                  state: 'error',
                  error: 'already_configured',
                })
              }
              publishRegistration(registrationId)
            }, 2_000)
            return { registration }
          }
          case 'feishu.app.register.get':
            return {
              registration:
                registrations.get(String(args.registrationId)) ??
                fail('feishu_registration_not_found'),
            }
          case 'feishu.app.register.cancel': {
            const current =
              registrations.get(String(args.registrationId)) ??
              fail('feishu_registration_not_found')
            const { url: _url, ...rest } = current
            const next: FeishuRegistration =
              current.state === 'waiting'
                ? { ...rest, revision: current.revision + 1, state: 'canceled' }
                : current
            registrations.set(current.registrationId, next)
            publishRegistration(current.registrationId)
            return { registration: next }
          }
          case 'feishu.app.configure':
            if (String(args.appSecret).length < 8) fail('feishu_credential_rejected')
            return add(String(args.appId), '新机器人')
          case 'feishu.app.rotate': {
            const app = find(String(args.appId))
            return save({
              ...app,
              revision: app.revision + 1,
              credential: { generation: app.credential.generation + 1, updatedAt: now() },
            })
          }
          case 'feishu.app.update': {
            const app = find(String(args.appId))
            if (app.revision !== args.expectedRevision) fail('feishu_revision_conflict')
            const managerId = args.managerId as string | null | undefined
            if (
              managerId &&
              apps.some((item) => item.appId !== app.appId && item.managerId === managerId)
            )
              fail('feishu_manager_taken')
            const enabled = typeof args.enabled === 'boolean' ? args.enabled : app.enabled
            return save({
              ...app,
              revision: app.revision + 1,
              ...(managerId === undefined ? {} : { managerId }),
              enabled,
              connection: enabled
                ? app.connection.state === 'stopped'
                  ? { state: 'connected', since: now(), lastConnectedAt: now(), reconnects: 0 }
                  : app.connection
                : { state: 'stopped', since: now(), reconnects: 0 },
            })
          }
          case 'feishu.app.remove': {
            const app = find(String(args.appId))
            if (app.revision !== args.expectedRevision) fail('feishu_revision_conflict')
            apps = apps.filter((item) => item.appId !== app.appId)
            publish()
            return {}
          }
          case 'feishu.app.check': {
            const app = find(String(args.appId))
            return save({
              ...app,
              capability: {
                ...(app.capability ?? {
                  missingScopes: [],
                  missingEvents: [],
                  missingCallbacks: [],
                  state: 'ok',
                }),
                checkedAt: now(),
              },
            })
          }
          case 'feishu.app.upgrade': {
            const app = find(String(args.appId))
            return save({
              ...app,
              capability: {
                checkedAt: now(),
                state: 'missing',
                missingScopes: app.capability?.missingScopes ?? [],
                missingEvents: [],
                missingCallbacks: [],
                publish: { state: 'pending_review', versionId: 'mock-version', at: now() },
              },
            })
          }
          default:
            throw new ChannelError('unknownCommand', `不认识的命令：${name}`)
        }
      },
    }
  }

  function of(deviceId: string) {
    const found = states.get(deviceId)
    if (found) return found
    const state = make(deviceId)
    states.set(deviceId, state)
    return state
  }

  return {
    of,
    command(name: string, params: unknown): Promise<unknown> | null {
      if (!isFeishuCommand(name)) return null
      const { deviceId, ...args } = params as { deviceId: string } & Record<string, unknown>
      return of(deviceId).command(name, args)
    },
  }
}

function fail(reason: string): never {
  throw new ChannelError('rejected', reason)
}
