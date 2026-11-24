// 设备的飞书来源：应用列表与创建向导的快照，命令转给设备。有人看才取，收到设备通知再重读。
import {
  FEISHU_NOTIFICATION,
  type FeishuApp,
  type FeishuChat,
  type FeishuRegistration,
  type FeishuRequests,
} from '../../../protocol/src/feishu.mjs'
import { isFeishuMethodParams } from '../../../protocol/src/feishu-validation.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import { phrase } from '../phrase.mjs'
import { FEISHU_COMMAND, type FeishuCommandName, type FeishuTopic } from '../projection/feishu.mjs'
import { ExternalRead, type ExternalReadHost } from './external-pages.mjs'

interface FeishuHost extends ExternalReadHost {
  supported(): boolean
  request<M extends keyof FeishuRequests>(
    method: M,
    params: FeishuRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<FeishuRequests[M]['result']>
}

function contains(value: unknown, secret: string): boolean {
  if (typeof value === 'string') return value.includes(secret)
  if (Array.isArray(value)) return value.some((item) => contains(item, secret))
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.values(value).some((item) => contains(item, secret))
  )
}

export function createFeishuDevice(host: FeishuHost) {
  const deviceSinks = new Set<HostSink>()
  // 管理员标记跟应用列表一起读；连接变了要重读
  let admin: boolean | null = null
  const apps = new ExternalRead<FeishuApp[]>(
    host,
    host.supported,
    () =>
      host.request('litch/feishu/app/list', {}).then((value) => {
        admin = value.admin ?? false
        return value.apps
      }),
    publish,
  )
  const registrations = new Map<string, ExternalRead<FeishuRegistration>>()
  type ChatsValue = { chats: FeishuChat[]; syncedAt: number | null }
  const chats = new Map<string, ExternalRead<ChatsValue>>()

  function view() {
    return { apps: apps.snapshot(), admin }
  }

  function publish() {
    const value = view()
    for (const sink of deviceSinks) sink.snapshot(value)
  }

  function chatsOf(appId: string) {
    const found = chats.get(appId)
    if (found) return found
    if (chats.size >= 8) {
      const old = [...chats].find(([, read]) => read.sinks.size === 0)
      if (old) chats.delete(old[0])
    }
    const read: ExternalRead<ChatsValue> = new ExternalRead(
      host,
      host.supported,
      () => host.request('litch/feishu/chat/list', { appId }),
      () => read.send(),
    )
    chats.set(appId, read)
    return read
  }

  function registrationOf(registrationId: string) {
    const found = registrations.get(registrationId)
    if (found) return found
    if (registrations.size >= 8) {
      const old = [...registrations].find(([, read]) => read.sinks.size === 0)
      if (old) registrations.delete(old[0])
    }
    const read: ExternalRead<FeishuRegistration> = new ExternalRead(
      host,
      host.supported,
      () =>
        host
          .request('litch/feishu/app/register/get', { registrationId })
          .then((value) => value.registration),
      () => read.send(),
    )
    registrations.set(registrationId, read)
    return read
  }

  const refreshApps = () => {
    if (deviceSinks.size) void apps.refresh()
  }

  async function command(name: FeishuCommandName, args: unknown, signal?: AbortSignalLike) {
    const method = FEISHU_COMMAND[name]
    if (!host.online())
      throw new ChannelError('offline', 'Device is offline', phrase('external.offline'))
    if (!host.supported())
      throw new ChannelError('unsupported', 'Feishu is unavailable', phrase('external.unsupported'))
    if (!isFeishuMethodParams(method, args))
      throw new ChannelError('invalid', 'Invalid Feishu request', phrase('feishu.invalid'))
    const secret = (args as { appSecret?: unknown }).appSecret
    const sensitive = typeof secret === 'string'
    try {
      const result = await host.request(method, args as never, {
        ...(signal ? { signal } : {}),
        ...(sensitive ? { sensitive: true } : {}),
      })
      if (sensitive && contains(result, secret))
        throw new ChannelError('remote', 'Device returned invalid credential data')
      if (name.startsWith('feishu.chat.')) {
        if (name !== 'feishu.chat.get' && name !== 'feishu.chat.members')
          chats.get((args as { appId: string }).appId)?.notify()
      } else if (name !== 'feishu.app.get' && name !== 'feishu.app.register.get') refreshApps()
      if (name.startsWith('feishu.app.register.')) {
        const registration = (result as { registration?: FeishuRegistration }).registration
        if (registration) registrations.get(registration.registrationId)?.notify()
      }
      return result
    } catch (error) {
      const failure = host.fail(error)
      if (!sensitive) throw failure
      // 带秘密的请求，远端错误正文可能复述请求；只让稳定类别穿过通道
      // 只放过设备给的原因代码（feishu_ 开头），界面据此选文案
      const reason = /^feishu_[a-z_]+$/.test(failure.message)
        ? failure.message
        : 'Credential operation failed'
      throw new ChannelError(failure.code, reason, failure.text ?? phrase('feishu.secretFailed'))
    }
  }

  return {
    open(topic: FeishuTopic, sink: HostSink): () => void {
      if (topic.kind === 'feishuRegistration')
        return registrationOf(topic.registrationId).open(sink)
      if (topic.kind === 'feishuChats') return chatsOf(topic.appId).open(sink)
      const first = deviceSinks.size === 0
      deviceSinks.add(sink)
      sink.snapshot(view())
      if (first) void apps.refresh()
      return () => {
        deviceSinks.delete(sink)
      }
    },
    command,
    connectionChanged() {
      admin = null
      apps.connectionChanged()
      refreshApps()
      for (const read of chats.values()) {
        read.connectionChanged()
        read.notify()
      }
      for (const read of registrations.values()) {
        read.connectionChanged()
        read.notify()
      }
    },
    notification(method: string, params: unknown): boolean {
      switch (method) {
        case FEISHU_NOTIFICATION.appsChanged:
          refreshApps()
          return true
        case FEISHU_NOTIFICATION.registrationChanged: {
          const id = (params as { registrationId?: unknown } | null)?.registrationId
          if (typeof id === 'string') registrations.get(id)?.notify()
          return true
        }
        case FEISHU_NOTIFICATION.chatsChanged: {
          const appId = (params as { appId?: unknown } | null)?.appId
          if (typeof appId === 'string') chats.get(appId)?.notify()
          return true
        }
        default:
          return false
      }
    },
  }
}
export type FeishuDevice = ReturnType<typeof createFeishuDevice>
