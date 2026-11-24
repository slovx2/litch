// 设备的飞书来源：应用列表与创建向导的快照，命令转给设备。有人看才取，收到设备通知再重读。
import {
  FEISHU_NOTIFICATION,
  type FeishuApp,
  type FeishuBinding,
  type FeishuChat,
  type FeishuInboxEntry,
  type FeishuInboxMessage,
  type FeishuOutboxEntry,
  type FeishuRegistration,
  type FeishuRequests,
} from '../../../protocol/src/feishu.mjs'
import { isFeishuMethodParams } from '../../../protocol/src/feishu-validation.mjs'
import {
  isReviewsMethodParams,
  REVIEWS_METHOD,
  REVIEWS_NOTIFICATION,
  type Review,
  type ReviewsRequests,
} from '../../../protocol/src/reviews.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { RpcRequestOptions } from '../connection/rpc.mjs'
import { phrase } from '../phrase.mjs'
import {
  FEISHU_COMMAND,
  type FeishuCommandName,
  type FeishuTopic,
  REVIEWS_COMMAND,
  type ReviewsCommandName,
} from '../projection/feishu.mjs'
import { ExternalRead, type ExternalReadHost } from './external-pages.mjs'

interface FeishuHost extends ExternalReadHost {
  supported(): boolean
  /** 设备有通用审批（litchReviews） */
  reviewsSupported(): boolean
  request<M extends keyof FeishuRequests | keyof ReviewsRequests>(
    method: M,
    params: (FeishuRequests & ReviewsRequests)[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<(FeishuRequests & ReviewsRequests)[M]['result']>
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
  type InboxValue = {
    entries: FeishuInboxEntry[]
    messages: Record<string, FeishuInboxMessage>
    next?: string
  }
  const inboxes = new Map<string, ExternalRead<InboxValue>>()
  type OutboxValue = { entries: FeishuOutboxEntry[]; next?: string }
  const outboxes = new Map<string, ExternalRead<OutboxValue>>()
  type BindingsValue = { bindings: FeishuBinding[] }
  const bindings = new Map<string, ExternalRead<BindingsValue>>()
  type ReviewsValue = { reviews: Review[]; pending: number }
  /** 键是 managerId，空串是全部 */
  const reviews = new Map<string, ExternalRead<ReviewsValue>>()

  /** 按键缓存的读取：最多留 8 份，满了先丢没人看的 */
  function cached<T>(map: Map<string, ExternalRead<T>>, key: string, make: () => ExternalRead<T>) {
    const found = map.get(key)
    if (found) return found
    if (map.size >= 8) {
      const old = [...map].find(([, read]) => read.sinks.size === 0)
      if (old) map.delete(old[0])
    }
    const read = make()
    map.set(key, read)
    return read
  }

  function outboxOf(appId: string) {
    return cached(outboxes, appId, () => {
      const read: ExternalRead<OutboxValue> = new ExternalRead(
        host,
        host.supported,
        () => host.request('litch/feishu/outbox/list', { appId, limit: 100 }),
        () => read.send(),
      )
      return read
    })
  }

  function bindingsOf(appId: string) {
    return cached(bindings, appId, () => {
      const read: ExternalRead<BindingsValue> = new ExternalRead(
        host,
        host.supported,
        () => host.request('litch/feishu/binding/list', { appId }),
        () => read.send(),
      )
      return read
    })
  }

  function reviewsOf(managerId: string) {
    return cached(reviews, managerId, () => {
      const filter = managerId ? { managerId } : {}
      const read: ExternalRead<ReviewsValue> = new ExternalRead(
        host,
        host.reviewsSupported,
        async () => {
          const [pending, recent] = await Promise.all([
            host.request(REVIEWS_METHOD.list, { ...filter, states: ['pending'], limit: 200 }),
            host.request(REVIEWS_METHOD.list, { ...filter, limit: 50 }),
          ])
          const seen = new Set(pending.reviews.map((review) => review.reviewId))
          return {
            reviews: [
              ...pending.reviews,
              ...recent.reviews.filter((review) => !seen.has(review.reviewId)),
            ],
            pending: pending.reviews.length,
          }
        },
        () => read.send(),
      )
      return read
    })
  }

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

  function inboxOf(managerId: string) {
    const found = inboxes.get(managerId)
    if (found) return found
    if (inboxes.size >= 8) {
      const old = [...inboxes].find(([, read]) => read.sinks.size === 0)
      if (old) inboxes.delete(old[0])
    }
    const read: ExternalRead<InboxValue> = new ExternalRead(
      host,
      host.supported,
      () => host.request('litch/feishu/inbox/list', { managerId, limit: 100 }),
      () => read.send(),
    )
    inboxes.set(managerId, read)
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
      if (name.startsWith('feishu.inbox.')) {
        // 只读，不用刷新
      } else if (name.startsWith('feishu.binding.')) {
        if (name !== 'feishu.binding.list' && name !== 'feishu.binding.lookup') {
          bindings.get((args as { appId: string }).appId)?.notify()
          refreshApps()
        }
      } else if (name.startsWith('feishu.outbox.')) {
        if (name === 'feishu.outbox.cancel')
          outboxes.get((args as { appId: string }).appId)?.notify()
      } else if (name.startsWith('feishu.chat.')) {
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

  async function reviewsCommand(
    name: ReviewsCommandName,
    args: unknown,
    signal?: AbortSignalLike,
  ): Promise<unknown> {
    const method = REVIEWS_COMMAND[name]
    if (!host.online())
      throw new ChannelError('offline', 'Device is offline', phrase('external.offline'))
    if (!host.reviewsSupported())
      throw new ChannelError(
        'unsupported',
        'Reviews are unavailable',
        phrase('external.unsupported'),
      )
    if (!isReviewsMethodParams(method, args))
      throw new ChannelError('invalid', 'Invalid review request', phrase('feishu.invalid'))
    try {
      const result = await host.request(method, args as never, signal ? { signal } : undefined)
      if (name === 'reviews.decide') for (const read of reviews.values()) read.notify()
      return result
    } catch (error) {
      throw host.fail(error)
    }
  }

  return {
    open(topic: FeishuTopic, sink: HostSink): () => void {
      if (topic.kind === 'feishuRegistration')
        return registrationOf(topic.registrationId).open(sink)
      if (topic.kind === 'feishuChats') return chatsOf(topic.appId).open(sink)
      if (topic.kind === 'feishuInbox') return inboxOf(topic.managerId).open(sink)
      if (topic.kind === 'feishuOutbox') return outboxOf(topic.appId).open(sink)
      if (topic.kind === 'feishuBindings') return bindingsOf(topic.appId).open(sink)
      if (topic.kind === 'reviews') return reviewsOf(topic.managerId ?? '').open(sink)
      const first = deviceSinks.size === 0
      deviceSinks.add(sink)
      sink.snapshot(view())
      if (first) void apps.refresh()
      return () => {
        deviceSinks.delete(sink)
      }
    },
    command,
    reviewsCommand,
    connectionChanged() {
      admin = null
      apps.connectionChanged()
      refreshApps()
      for (const read of chats.values()) {
        read.connectionChanged()
        read.notify()
      }
      for (const read of [
        ...registrations.values(),
        ...inboxes.values(),
        ...outboxes.values(),
        ...bindings.values(),
        ...reviews.values(),
      ]) {
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
        case FEISHU_NOTIFICATION.bindingsChanged: {
          const appId = (params as { appId?: unknown } | null)?.appId
          if (typeof appId === 'string') bindings.get(appId)?.notify()
          return true
        }
        case FEISHU_NOTIFICATION.outboxChanged: {
          const appId = (params as { appId?: unknown } | null)?.appId
          if (typeof appId === 'string') outboxes.get(appId)?.notify()
          return true
        }
        case REVIEWS_NOTIFICATION.changed: {
          const managerId = (params as { managerId?: unknown } | null)?.managerId
          reviews.get('')?.notify()
          if (typeof managerId === 'string') reviews.get(managerId)?.notify()
          return true
        }
        case FEISHU_NOTIFICATION.inboxChanged: {
          const managerId = (params as { managerId?: unknown } | null)?.managerId
          if (typeof managerId === 'string') inboxes.get(managerId)?.notify()
          return true
        }
        default:
          return false
      }
    },
  }
}
export type FeishuDevice = ReturnType<typeof createFeishuDevice>
