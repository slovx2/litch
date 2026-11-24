// 模拟核心里的飞书来源：每台在线设备一份应用列表，创建向导两秒后自动完成。样例全是虚构的名字和 ID。
import type {
  FeishuApp,
  FeishuChat,
  FeishuInboxEntry,
  FeishuInboxMessage,
  FeishuMember,
  FeishuOutboxEntry,
  FeishuRegistration,
} from '../../../protocol/src/feishu.mjs'
import type { Review } from '../../../protocol/src/reviews.mjs'
import { ChannelError, type Clock } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { DeviceView } from '../model.mjs'
import { type FeishuTopic, isFeishuCommand, isReviewsCommand } from '../projection/feishu.mjs'

const sampleAppId = 'cli_a1b2c3d4e5f60718'
const sampleApp = (now: number, managerId: string | null): FeishuApp => ({
  appId: sampleAppId,
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

const sampleMembers: FeishuMember[] = [
  { openId: 'ou_mock_alice', name: '示例成员甲' },
  { openId: 'ou_mock_bob', name: '示例成员乙' },
  { openId: 'ou_mock_carol', name: '示例成员丙' },
]

const sampleChats = (appId: string, now: number): FeishuChat[] => [
  {
    appId,
    chatId: 'oc_mock_project',
    revision: 2,
    name: '示例项目群',
    external: false,
    status: 'normal',
    botPresent: true,
    access: {
      speech: 'free',
      wakeBound: true,
      wakers: [{ openId: 'ou_mock_alice', name: '示例成员甲' }],
      retentionDays: 90,
      reviewTtlHours: 24,
      accessAt: now - 86_400,
    },
    updatedAt: now - 86_400,
    records: {
      messages: 326,
      oldestAt: now - 86_400 * 8,
      backfill: {
        kind: 'access',
        state: 'done',
        start: now - 86_400 * 8,
        end: now - 86_400,
        fetched: 214,
        truncated: false,
        startedAt: now - 86_400,
        finishedAt: now - 86_400 + 12,
      },
      gap: { at: now - 600, start: now - 1_500, end: now - 600, fetched: 4, complete: true },
    },
  },
  {
    appId,
    chatId: 'oc_mock_partner',
    revision: 1,
    name: '示例合作群',
    external: true,
    status: 'normal',
    botPresent: true,
    access: null,
    updatedAt: now - 7_200,
  },
  {
    appId,
    chatId: 'oc_mock_casual',
    revision: 1,
    name: '示例闲聊群',
    external: false,
    status: 'normal',
    botPresent: true,
    access: null,
    updatedAt: now - 3_600,
  },
  {
    appId,
    chatId: 'oc_mock_left',
    revision: 3,
    name: '示例旧项目群',
    external: false,
    status: 'normal',
    botPresent: false,
    access: {
      speech: 'approval',
      wakeBound: false,
      wakers: [],
      retentionDays: 30,
      reviewTtlHours: 12,
      accessAt: now - 86_400 * 10,
    },
    updatedAt: now - 86_400 * 2,
    records: { messages: 41, oldestAt: now - 86_400 * 17 },
  },
]

/** 样例发件：一条待审批、一条已发出（两段）、一条结果不明停下、一条被拒 */
const sampleOutbox = (appId: string, managerId: string, now: number): FeishuOutboxEntry[] => {
  const base = {
    appId,
    managerId,
    target: { kind: 'chat' as const, id: 'oc_mock_review', name: '示例审批群' },
    mentions: [],
    attempts: 0,
    messageIds: [],
  }
  return [
    {
      ...base,
      operationId: 'fs_mock_pending',
      format: 'post',
      summary: '本周进度：接口联调完成，下周开始灰度。',
      parts: 1,
      mentions: [{ openId: 'ou_mock_owner', name: '示例负责人' }],
      state: 'awaiting_approval',
      reviewId: 'A-3',
      createdAt: now - 300,
      updatedAt: now - 300,
    },
    {
      ...base,
      operationId: 'fs_mock_sent',
      target: { kind: 'chat', id: 'oc_mock_project', name: '示例项目群' },
      format: 'card',
      summary: '| 模块 | 状态 |',
      parts: 2,
      messageIds: ['om_mock_sent_1', 'om_mock_sent_2'],
      state: 'sent',
      attempts: 1,
      createdAt: now - 3600,
      updatedAt: now - 3590,
      sentAt: now - 3590,
    },
    {
      ...base,
      operationId: 'fs_mock_unknown',
      target: { kind: 'chat', id: 'oc_mock_project', name: '示例项目群' },
      format: 'file',
      summary: '周报.pdf',
      parts: 1,
      state: 'unknown',
      attempts: 6,
      error: 'unknown_timeout',
      createdAt: now - 7200,
      updatedAt: now - 3600,
    },
    {
      ...base,
      operationId: 'fs_mock_rejected',
      format: 'text',
      summary: '大家好，明天停机维护两小时。',
      parts: 1,
      state: 'rejected',
      reviewId: 'A-1',
      error: 'review_rejected',
      createdAt: now - 86_400,
      updatedAt: now - 86_000,
    },
  ]
}

/** 样例审批：两条待批（一条带 @ 和回复、一条图片）、一条已拒 */
const sampleReviews = (appId: string, managerId: string, now: number): Review[] => {
  const base = {
    kind: 'speech' as const,
    provider: 'feishu',
    scope: `${appId}/oc_mock_review`,
    requestedBy: { managerId, threadId: 'mock-thread', turnId: 'mock-turn' },
    payloadHash: '0'.repeat(64),
  }
  const preview = {
    kind: 'speech' as const,
    provider: 'feishu' as const,
    appId,
    appName: '示例机器人',
    target: { kind: 'chat' as const, id: 'oc_mock_review', name: '示例审批群' },
    actingAs: { type: 'bot' as const },
    mentions: [],
  }
  return [
    {
      ...base,
      reviewId: 'A-3',
      revision: 1,
      subjectRef: 'fs_mock_pending',
      preview: {
        ...preview,
        replyTo: { messageId: 'om_mock_ask', text: '这周进度怎么样？' },
        mentions: [{ openId: 'ou_mock_owner', name: '示例负责人' }],
        parts: [
          {
            format: 'post',
            text: '@示例负责人 本周进度：接口联调完成，下周开始灰度。\n\n- 风险：第三方回调偶发超时\n- 需要：确认灰度名单',
          },
        ],
      },
      state: 'pending',
      createdAt: now - 300,
      expiresAt: now + 86_100,
    },
    {
      ...base,
      reviewId: 'A-2',
      revision: 1,
      subjectRef: 'fs_mock_image',
      preview: { ...preview, parts: [{ format: 'image', name: '架构图.png', size: 182_400 }] },
      state: 'pending',
      createdAt: now - 900,
      expiresAt: now + 2700,
    },
    {
      ...base,
      reviewId: 'A-1',
      revision: 2,
      subjectRef: 'fs_mock_rejected',
      preview: { ...preview, parts: [{ format: 'text', text: '大家好，明天停机维护两小时。' }] },
      state: 'rejected',
      decidedBy: { via: 'litch' },
      decidedAt: now - 86_000,
      reason: '时间还没定',
      createdAt: now - 86_400,
      expiresAt: now,
    },
  ]
}

/** 样例收件箱：一条刚到（排队）、一条已送进回合、一条已处理、一条过了保留期只剩 ID */
const sampleInbox = (appId: string, managerId: string, now: number) => {
  const base = {
    appId,
    managerId,
    chatId: 'oc_mock_project',
    chatKind: 'group' as const,
  }
  const entries: FeishuInboxEntry[] = [
    {
      ...base,
      inboxId: 'FI-4',
      status: 'queued',
      messageId: 'om_mock_4',
      senderOpenId: 'ou_mock_alice',
      senderName: '示例成员甲',
      senderIdentity: 'member',
      trigger: 'mention',
      createdAt: now - 12,
      receivedAt: now - 11,
    },
    {
      ...base,
      inboxId: 'FI-3',
      status: 'notified',
      messageId: 'om_mock_3',
      senderOpenId: 'ou_mock_alice',
      senderName: '示例成员甲',
      senderIdentity: 'member',
      trigger: 'reply',
      createdAt: now - 900,
      receivedAt: now - 899,
      deliveryId: 'mock-delivery-1',
      notifiedAt: now - 870,
    },
    {
      ...base,
      inboxId: 'FI-2',
      status: 'processed',
      messageId: 'om_mock_2',
      senderOpenId: 'ou_mock_bob',
      senderName: '示例成员乙',
      senderIdentity: 'member',
      trigger: 'mention',
      createdAt: now - 86_400,
      receivedAt: now - 86_399,
      deliveryId: 'mock-delivery-0',
      notifiedAt: now - 86_370,
      processedAt: now - 86_000,
    },
    {
      ...base,
      inboxId: 'FI-1',
      status: 'processed',
      messageId: 'om_mock_1',
      senderOpenId: 'ou_mock_carol',
      senderIdentity: 'unknown',
      trigger: 'mention',
      createdAt: now - 86_400 * 100,
      receivedAt: now - 86_400 * 100,
      processedAt: now - 86_400 * 99,
    },
  ]
  const message = (text: string | null, purged = false): FeishuInboxMessage => ({
    chatName: '示例项目群',
    text,
    msgType: 'text',
    state: 'normal',
    purged,
  })
  const messages: Record<string, FeishuInboxMessage> = {
    'FI-4': message('@示例助手 帮忙看一下发布清单还差什么'),
    'FI-3': message('好的，那就按这个顺序来，有问题再找你'),
    'FI-2': message('@示例助手 周报整理好了吗'),
    'FI-1': message(null, true),
  }
  return { entries, messages }
}

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
    const chats = new Map<string, FeishuChat[]>()
    const chatSinks = new Map<string, Set<HostSink>>()
    const inboxSinks = new Map<string, Set<HostSink>>()
    const outboxSinks = new Map<string, Set<HostSink>>()
    const reviewSinks = new Map<string, Set<HostSink>>()
    const managed = filled && deviceId === 'local'
    let outbox: FeishuOutboxEntry[] = managed ? sampleOutbox(sampleAppId, 'm1', now()) : []
    let reviews: Review[] = managed ? sampleReviews(sampleAppId, 'm1', now()) : []
    const ready = (value: unknown) => ({
      available: true,
      online: true,
      value,
      fetchedAt: clock.now(),
      error: null,
    })
    const publishOutbox = (appId: string) => {
      const value = { entries: outbox.filter((entry) => entry.appId === appId) }
      for (const sink of outboxSinks.get(appId) ?? []) sink.snapshot(ready(value))
    }
    const reviewsFor = (managerId: string) => {
      const mine = reviews.filter(
        (review) => !managerId || review.requestedBy.managerId === managerId,
      )
      const pending = mine.filter((review) => review.state === 'pending')
      return {
        reviews: [...pending, ...mine.filter((review) => review.state !== 'pending')],
        pending: pending.length,
      }
    }
    const publishReviews = () => {
      for (const [managerId, set] of reviewSinks)
        for (const sink of set) sink.snapshot(ready(reviewsFor(managerId)))
    }
    const inboxOf = (managerId: string) => {
      const app = apps.find((item) => item.managerId === managerId)
      return app ? sampleInbox(app.appId, managerId, now()) : { entries: [], messages: {} }
    }
    const publishInbox = (managerId: string) => {
      const value = inboxOf(managerId)
      for (const sink of inboxSinks.get(managerId) ?? [])
        sink.snapshot({ available: true, online: true, value, fetchedAt: clock.now(), error: null })
    }
    const chatsOf = (appId: string) => {
      const found = chats.get(appId)
      if (found) return found
      const value = apps.some((app) => app.appId === appId && app.managerId)
        ? sampleChats(appId, now())
        : []
      chats.set(appId, value)
      return value
    }
    const publishChats = (appId: string) => {
      const value = { chats: chatsOf(appId), syncedAt: now() - 60 }
      for (const sink of chatSinks.get(appId) ?? [])
        sink.snapshot({ available: true, online: true, value, fetchedAt: clock.now(), error: null })
    }
    const chatOf = (appId: string, chatId: string) =>
      chatsOf(appId).find((chat) => chat.chatId === chatId) ?? fail('feishu_chat_not_found')
    const saveChat = (chat: FeishuChat | null, appId: string, chatId: string) => {
      const rest = chatsOf(appId).filter((item) => item.chatId !== chatId)
      chats.set(
        appId,
        chat ? chatsOf(appId).map((item) => (item.chatId === chatId ? chat : item)) : rest,
      )
      publishChats(appId)
      return chat
    }
    const wakersOf = (openIds: unknown) =>
      (openIds as string[]).map(
        (openId) =>
          sampleMembers.find((member) => member.openId === openId) ??
          fail('feishu_waker_not_member'),
      )
    const snapshot = () => ({
      apps: {
        available: true,
        online: online(deviceId),
        value: apps,
        fetchedAt: clock.now(),
        error: null,
      },
      admin: true,
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
        if (topic.kind === 'feishuChats') {
          const set = chatSinks.get(topic.appId) ?? new Set<HostSink>()
          chatSinks.set(topic.appId, set)
          set.add(sink)
          publishChats(topic.appId)
          return () => set.delete(sink)
        }
        if (topic.kind === 'feishuOutbox') {
          const set = outboxSinks.get(topic.appId) ?? new Set<HostSink>()
          outboxSinks.set(topic.appId, set)
          set.add(sink)
          publishOutbox(topic.appId)
          return () => set.delete(sink)
        }
        if (topic.kind === 'reviews') {
          const key = topic.managerId ?? ''
          const set = reviewSinks.get(key) ?? new Set<HostSink>()
          reviewSinks.set(key, set)
          set.add(sink)
          sink.snapshot(ready(reviewsFor(key)))
          return () => set.delete(sink)
        }
        if (topic.kind === 'feishuInbox') {
          const set = inboxSinks.get(topic.managerId) ?? new Set<HostSink>()
          inboxSinks.set(topic.managerId, set)
          set.add(sink)
          publishInbox(topic.managerId)
          return () => set.delete(sink)
        }
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
          case 'feishu.chat.list':
            find(String(args.appId))
            publishChats(String(args.appId))
            return { chats: chatsOf(String(args.appId)), syncedAt: now() }
          case 'feishu.chat.get':
            return { chat: chatOf(String(args.appId), String(args.chatId)) }
          case 'feishu.chat.members': {
            const chat = chatOf(String(args.appId), String(args.chatId))
            if (!chat.botPresent) fail('feishu_chat_unavailable')
            return { members: sampleMembers, fetchedAt: now() }
          }
          case 'feishu.chat.access': {
            const appId = String(args.appId)
            const chat = chatOf(appId, String(args.chatId))
            if (chat.access) fail('feishu_chat_accessed')
            if (!chat.botPresent) fail('feishu_chat_unavailable')
            if (chat.revision !== args.expectedRevision) fail('feishu_revision_conflict')
            if (chat.external && args.confirmExternal !== true) fail('feishu_external_unconfirmed')
            const next: FeishuChat = {
              ...chat,
              revision: chat.revision + 1,
              access: {
                speech: args.speech as 'free' | 'approval',
                wakeBound: Boolean(args.wakeBound),
                wakers: wakersOf(args.wakers),
                retentionDays: Number(args.retentionDays),
                reviewTtlHours: Number(args.reviewTtlHours),
                accessAt: now(),
              },
              updatedAt: now(),
              // 模拟核心不真的补，直接给补完的样子
              records: {
                messages: (chat.records?.messages ?? 0) + 37,
                oldestAt: now() - 86_400 * 7,
                backfill: {
                  kind: 'access',
                  state: 'done',
                  start: now() - 86_400 * 7,
                  end: now(),
                  fetched: 37,
                  truncated: false,
                  startedAt: now(),
                  finishedAt: now(),
                },
              },
            }
            return { chat: saveChat(next, appId, chat.chatId) }
          }
          case 'feishu.chat.update': {
            const appId = String(args.appId)
            const chat = chatOf(appId, String(args.chatId))
            if (!chat.access) fail('feishu_chat_not_accessed')
            if (chat.revision !== args.expectedRevision) fail('feishu_revision_conflict')
            const next: FeishuChat = {
              ...chat,
              revision: chat.revision + 1,
              access: {
                ...chat.access,
                ...(args.speech ? { speech: args.speech as 'free' | 'approval' } : {}),
                ...(typeof args.wakeBound === 'boolean' ? { wakeBound: args.wakeBound } : {}),
                ...(args.wakers ? { wakers: wakersOf(args.wakers) } : {}),
                ...(typeof args.retentionDays === 'number'
                  ? { retentionDays: args.retentionDays }
                  : {}),
                ...(typeof args.reviewTtlHours === 'number'
                  ? { reviewTtlHours: args.reviewTtlHours }
                  : {}),
              },
              updatedAt: now(),
            }
            return { chat: saveChat(next, appId, chat.chatId) }
          }
          case 'feishu.chat.unaccess': {
            const appId = String(args.appId)
            const chat = chatOf(appId, String(args.chatId))
            if (!chat.access) fail('feishu_chat_not_accessed')
            if (chat.revision !== args.expectedRevision) fail('feishu_revision_conflict')
            const { records, ...rest } = chat
            const next: FeishuChat = {
              ...rest,
              revision: chat.revision + 1,
              access: null,
              updatedAt: now(),
              ...(records && args.deleteRecords !== true ? { records } : {}),
            }
            saveChat(chat.botPresent ? next : null, appId, chat.chatId)
            return { chat: next }
          }
          case 'feishu.chat.backfill': {
            const appId = String(args.appId)
            const chat = chatOf(appId, String(args.chatId))
            if (!chat.access) fail('feishu_chat_not_accessed')
            if (!chat.botPresent) fail('feishu_chat_unavailable')
            const start = Number(args.start)
            const end = Math.min(Number(args.end), now())
            const next: FeishuChat = {
              ...chat,
              records: {
                ...(chat.records ?? { messages: 0 }),
                messages: (chat.records?.messages ?? 0) + 18,
                oldestAt: Math.min(chat.records?.oldestAt ?? start, start),
                backfill: {
                  kind: 'manual',
                  state: 'done',
                  start,
                  end,
                  fetched: 18,
                  truncated: false,
                  startedAt: now(),
                  finishedAt: now(),
                },
              },
            }
            return { chat: saveChat(next, appId, chat.chatId) }
          }
          case 'feishu.inbox.list':
            return inboxOf(String(args.managerId))
          case 'feishu.inbox.get': {
            for (const app of apps) {
              if (!app.managerId) continue
              const { entries, messages } = inboxOf(app.managerId)
              const entry = entries.find((item) => item.inboxId === args.inboxId)
              if (entry) return { entry, message: messages[entry.inboxId] ?? null }
            }
            return fail('feishu_inbox_not_found')
          }
          case 'feishu.outbox.list':
            return { entries: outbox.filter((entry) => entry.appId === args.appId) }
          case 'feishu.outbox.cancel': {
            const entry = outbox.find((item) => item.operationId === args.operationId)
            if (!entry) return fail('feishu_outbox_not_found')
            if (entry.state === 'sending') return fail('feishu_outbox_sending')
            const done = ['sent', 'failed', 'rejected', 'canceled'].includes(entry.state)
            const next: FeishuOutboxEntry = done
              ? entry
              : { ...entry, state: 'canceled', error: 'canceled_by_admin', updatedAt: now() }
            outbox = outbox.map((item) => (item === entry ? next : item))
            if (entry.reviewId && !done)
              reviews = reviews.map((review) =>
                review.reviewId === entry.reviewId && review.state === 'pending'
                  ? {
                      ...review,
                      state: 'canceled',
                      revision: review.revision + 1,
                      decidedAt: now(),
                    }
                  : review,
              )
            publishOutbox(entry.appId)
            publishReviews()
            return { entry: next }
          }
          case 'reviews.list':
            return reviewsFor(String(args.managerId ?? ''))
          case 'reviews.get': {
            const review = reviews.find((item) => item.reviewId === args.reviewId)
            return review ? { review } : fail('review_not_found')
          }
          case 'reviews.decide': {
            const review = reviews.find((item) => item.reviewId === args.reviewId)
            if (!review) return fail('review_not_found')
            if (review.revision !== args.expectedRevision) return fail('review_revision_conflict')
            if (review.state !== 'pending') return fail('review_not_pending')
            const approved = args.decision === 'approve'
            const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
            const next: Review = {
              ...review,
              state: approved ? 'approved' : 'rejected',
              revision: review.revision + 1,
              decidedBy: { via: 'litch' },
              decidedAt: now(),
              ...(reason ? { reason } : {}),
            }
            reviews = reviews.map((item) => (item === review ? next : item))
            outbox = outbox.map((entry) =>
              entry.operationId === review.subjectRef
                ? approved
                  ? {
                      ...entry,
                      state: 'sent',
                      attempts: 1,
                      messageIds: ['om_mock_approved'],
                      updatedAt: now(),
                      sentAt: now(),
                    }
                  : { ...entry, state: 'rejected', error: 'review_rejected', updatedAt: now() }
                : entry,
            )
            publishReviews()
            for (const appId of new Set(outbox.map((entry) => entry.appId))) publishOutbox(appId)
            return { review: next }
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
      if (!isFeishuCommand(name) && !isReviewsCommand(name)) return null
      const { deviceId, ...args } = params as { deviceId: string } & Record<string, unknown>
      return of(deviceId).command(name, args)
    },
  }
}

function fail(reason: string): never {
  throw new ChannelError('rejected', reason)
}
