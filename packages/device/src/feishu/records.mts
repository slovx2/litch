// 记录与历史：已接入群的消息落进消息库（D-163、D-164、D-165、D-167）。
// - 实时：收消息事件在处理函数里同步落库再返回（SDK 随后才回 ACK），未接入的群直接丢弃，不留任何正文。
// - 补历史：接入时补最近 7 天、手动补一段、每次连上补断线期间的缺口；同一应用的历史请求串行。
// - 回源：合并转发、卡片、名片要再读一次才看得全，落库后在后台补上，不拖慢 ACK。
// - 清理：每天按群的保留天数删旧消息；被引用的只清正文。撤回的换成“[已撤回]”。
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import {
  FEISHU_BACKFILL_LIMIT,
  FEISHU_NOTIFICATION,
  type FeishuChatRecords,
} from '../../../protocol/src/feishu.mjs'
import { type FeishuApi, FeishuApiError } from './api.mjs'
import type { FeishuChatRecord, FeishuChats } from './chats.mjs'
import {
  cardText,
  clip,
  expandForward,
  type ForwardChild,
  type MentionRef,
  type ParsedContent,
  parseContent,
} from './content.mjs'
import type {
  ImMessages,
  MessageSource,
  NewMessage,
  StoredAttachment,
  StoredMention,
  StoredMessage,
} from './messages.mjs'

/** 文件名里只留安全字符，不让路径跳出附件目录 */
const safeName = (name: string) =>
  name
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^\.+/, '')
    .slice(0, 120)

/** 接入时补多少天 */
const ACCESS_BACKFILL_DAYS = 7
/** 补缺口从水位往前多补一点，防止边界上漏掉 */
const GAP_OVERLAP_MS = 120_000
const PAGE_SIZE = 50
const DAY = 86_400
/** 限流时最多等多久再试、试几次 */
const RATE_WAIT_MAX_MS = 60_000
const RATE_RETRIES = 5
/** 合并转发里最多回源几张子卡片 */
const FORWARD_CARD_FETCH = 10

export interface FeishuRecordsOptions {
  messages: ImMessages
  chats: FeishuChats
  api: (appId: string) => FeishuApi | null
  /** 秒 */
  now: () => number
  announce: (method: string, params: unknown) => void
  fail: (reason: string) => never
  log: (message: string) => void
  /** 附件下载目录；删除时只删这个目录里的文件 */
  attachmentsDirectory: string
  /** 测试：清理间隔 */
  purgeEveryMs?: number
}

/** 事件和历史接口两种来源的消息，统一成一个形状 */
interface Incoming {
  messageId: string
  chatId: string
  chatKind: 'group' | 'p2p'
  rootId?: string
  parentId?: string
  threadId?: string
  msgType: string
  content: unknown
  createTime: number
  updateTime: number
  senderId: string
  senderIdType: 'open_id' | 'app_id'
  senderType: 'user' | 'app'
  mentions: StoredMention[]
  deleted: boolean
  updated: boolean
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 256): string =>
  typeof value === 'string' ? value.slice(0, max) : ''
const ms = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}
const optional = (key: string, value: string) => (value ? { [key]: value } : {})

function mentionsOf(raw: unknown): StoredMention[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isObject).map((item) => ({
    key: text(item.key, 64),
    // 事件里 id 是对象（{open_id}），历史接口里 id 直接是字符串
    openId: isObject(item.id) ? text(item.id.open_id, 128) : text(item.id, 128),
    name: text(item.name),
  }))
}

/** 收消息事件（摊平后的 data） */
function fromEvent(data: Json): Incoming | null {
  const message = isObject(data.message) ? data.message : null
  const sender = isObject(data.sender) ? data.sender : {}
  const senderId = isObject(sender.sender_id) ? text(sender.sender_id.open_id, 128) : ''
  if (!message || !senderId) return null
  const messageId = text(message.message_id, 128)
  const chatId = text(message.chat_id, 128)
  if (!messageId || !chatId) return null
  const createTime = ms(message.create_time)
  return {
    messageId,
    chatId,
    chatKind: message.chat_type === 'p2p' ? 'p2p' : 'group',
    ...optional('rootId', text(message.root_id, 128)),
    ...optional('parentId', text(message.parent_id, 128)),
    ...optional('threadId', text(message.thread_id, 128)),
    msgType: text(message.message_type, 64),
    content: message.content,
    createTime,
    updateTime: ms(message.update_time) || createTime,
    senderId,
    senderIdType: 'open_id',
    senderType: sender.sender_type === 'app' ? 'app' : 'user',
    mentions: mentionsOf(message.mentions),
    deleted: false,
    updated: false,
  }
}

/** 历史接口、单条消息接口的一项 */
function fromHistory(item: Json): Incoming | null {
  const messageId = text(item.message_id, 128)
  const chatId = text(item.chat_id, 128)
  const sender = isObject(item.sender) ? item.sender : {}
  if (!messageId || !chatId) return null
  const createTime = ms(item.create_time)
  return {
    messageId,
    chatId,
    chatKind: 'group',
    ...optional('rootId', text(item.root_id, 128)),
    ...optional('parentId', text(item.parent_id, 128)),
    ...optional('threadId', text(item.thread_id, 128)),
    msgType: text(item.msg_type, 64),
    content: isObject(item.body) ? item.body.content : '',
    createTime,
    updateTime: ms(item.update_time) || createTime,
    senderId: text(sender.id, 128),
    senderIdType: sender.id_type === 'app_id' ? 'app_id' : 'open_id',
    senderType: sender.sender_type === 'app' ? 'app' : 'user',
    mentions: mentionsOf(item.mentions),
    deleted: item.deleted === true,
    updated: item.updated === true,
  }
}

const mentionRefs = (mentions: StoredMention[]): MentionRef[] =>
  mentions.map((item) => ({ key: item.key, name: item.name }))

function parsed(incoming: Incoming): ParsedContent {
  return parseContent(incoming.msgType, incoming.content, {
    messageId: incoming.messageId,
    mentions: mentionRefs(incoming.mentions),
  })
}

const rawContent = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

const sleep = (delay: number) => new Promise((resolve) => setTimeout(resolve, delay))

export class FeishuRecords {
  private readonly options: FeishuRecordsOptions
  /** 每个应用一条串行的历史请求队列 */
  private readonly queues = new Map<string, Promise<void>>()
  /** 落库之后要做的事（收件箱判定等，后续里程碑挂进来） */
  private readonly storedHooks: ((message: StoredMessage, source: MessageSource) => void)[] = []
  private purgeTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(options: FeishuRecordsOptions) {
    this.options = options
  }

  private get messages(): ImMessages {
    return this.options.messages
  }

  onStored(hook: (message: StoredMessage, source: MessageSource) => void): void {
    this.storedHooks.push(hook)
  }

  start(): void {
    this.purgeAll()
    this.purgeTimer = setInterval(
      () => this.purgeAll(),
      this.options.purgeEveryMs ?? DAY * 1000,
    ).unref()
  }

  close(): void {
    this.closed = true
    if (this.purgeTimer) clearInterval(this.purgeTimer)
    this.purgeTimer = null
  }

  /** 等当前排着的历史请求和回源都做完（测试用） */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.queues.values()]
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  private enqueue(appId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(appId) ?? Promise.resolve()
    const next = previous
      .then(() => (this.closed ? undefined : work()))
      .catch((error: Error) => this.options.log(`飞书历史请求出错：${error.message}`))
    const tracked = next.finally(() => {
      if (this.queues.get(appId) === tracked) this.queues.delete(appId)
    })
    this.queues.set(appId, tracked)
    return tracked
  }

  private changed(appId: string, chatId: string): void {
    this.options.announce(FEISHU_NOTIFICATION.chatsChanged, { appId, chatId })
  }

  /** 群在设备上的记录；没有任何记录也没有水位时为空 */
  view(appId: string, chatId: string): FeishuChatRecords | undefined {
    const sync = this.messages.sync(appId, chatId)
    const { messages, oldestAt } = this.messages.count(appId, chatId)
    if (!sync && messages === 0) return undefined
    const backfill = sync?.backfill
    return {
      messages,
      ...(oldestAt === null ? {} : { oldestAt: Math.floor(oldestAt / 1000) }),
      ...(backfill
        ? {
            backfill: {
              kind: backfill.kind,
              state: backfill.state,
              start: backfill.start,
              end: backfill.end,
              fetched: backfill.fetched,
              truncated: backfill.truncated,
              startedAt: backfill.startedAt,
              ...(backfill.finishedAt === undefined ? {} : { finishedAt: backfill.finishedAt }),
            },
          }
        : {}),
      ...(sync?.gap ? { gap: sync.gap } : {}),
    }
  }

  // —— 落库 ——

  /** 存一条消息：已有的按平台最新版更新（撤回、编辑）；返回新存进来的那行 */
  private store(appId: string, incoming: Incoming, source: MessageSource): StoredMessage | null {
    const existing = this.messages.get(appId, incoming.messageId)
    if (existing) {
      if (incoming.deleted) this.drop(this.messages.recall(appId, incoming.messageId))
      else if (incoming.updated && incoming.updateTime > existing.updateTime) {
        const content = parsed(incoming)
        this.messages.rewrite(
          appId,
          incoming.messageId,
          {
            text: clip(content.text),
            content: rawContent(incoming.content),
            updateTime: incoming.updateTime,
            mentions: incoming.mentions,
          },
          content.attachments,
        )
        if (content.detail) this.enrichLater(appId, incoming.messageId, content)
      }
      return null
    }
    if (incoming.deleted) return null
    const content = parsed(incoming)
    const row: NewMessage = {
      appId,
      messageId: incoming.messageId,
      chatId: incoming.chatId,
      chatKind: incoming.chatKind,
      ...(incoming.rootId ? { rootId: incoming.rootId } : {}),
      ...(incoming.parentId ? { parentId: incoming.parentId } : {}),
      ...(incoming.threadId ? { threadId: incoming.threadId } : {}),
      senderId: incoming.senderId,
      senderIdType: incoming.senderIdType,
      senderType: incoming.senderType,
      msgType: incoming.msgType,
      text: clip(content.text),
      content: rawContent(incoming.content),
      mentions: incoming.mentions,
      createTime: incoming.createTime,
      updateTime: incoming.updateTime,
      state: 'normal',
      source,
      triage: 'done',
    }
    const { message, inserted } = this.messages.insert(row, content.attachments)
    if (!inserted) return null
    if (content.detail) this.enrichLater(appId, incoming.messageId, content)
    for (const hook of this.storedHooks) {
      try {
        hook(message, source)
      } catch (error) {
        this.options.log(`飞书消息落库后的处理出错：${(error as Error).message}`)
      }
    }
    return message
  }

  private retentionOf(appId: string, chatId: string): number {
    return this.options.chats.record(appId, chatId)?.access?.retentionDays ?? 90
  }

  private advance(appId: string, chatId: string, createTime: number): void {
    this.messages.patchSync(appId, chatId, this.retentionOf(appId, chatId), (sync) => ({
      ...sync,
      liveWatermark: Math.max(sync.liveWatermark ?? 0, createTime),
    }))
  }

  /** 收消息事件：只记已接入的群；私聊留给私聊绑定 */
  received(appId: string, data: Json): void {
    const incoming = fromEvent(data)
    if (!incoming || incoming.chatKind !== 'group') return
    const { chats } = this.options
    if (!chats.active(appId, incoming.chatId)) {
      // 未接入：不落库、不计数（D-167）；列表里没有这个群说明漏了进群事件，回源对一遍
      if (!chats.record(appId, incoming.chatId)) void chats.sync(appId).catch(() => undefined)
      return
    }
    this.store(appId, incoming, 'event')
    this.advance(appId, incoming.chatId, incoming.createTime)
  }

  recalled(appId: string, data: Json): void {
    const messageId = text(data.message_id, 128)
    const current = messageId ? this.messages.get(appId, messageId) : null
    if (!current) return
    this.drop(this.messages.recall(appId, messageId))
  }

  /** 成员进群；只管已接入的群 */
  membersAdded(appId: string, data: Json): void {
    const chatId = text(data.chat_id, 128)
    if (!this.options.chats.active(appId, chatId)) return
    const users = Array.isArray(data.users) ? data.users.filter(isObject) : []
    const members = users
      .map((user) => ({
        openId: isObject(user.user_id) ? text(user.user_id.open_id, 128) : '',
        name: text(user.name),
      }))
      .filter((member) => /^ou_/.test(member.openId))
      .map((member) => ({ ...member, name: member.name || member.openId }))
    this.messages.saveMembers(appId, chatId, members, this.options.now(), false)
    this.options.chats.forgetMembers(appId, chatId)
  }

  membersRemoved(appId: string, data: Json): void {
    const chatId = text(data.chat_id, 128)
    if (!this.options.chats.active(appId, chatId)) return
    const users = Array.isArray(data.users) ? data.users.filter(isObject) : []
    const openIds = users
      .map((user) => (isObject(user.user_id) ? text(user.user_id.open_id, 128) : ''))
      .filter(Boolean)
    this.messages.membersLeft(appId, chatId, openIds, this.options.now())
    this.options.chats.forgetMembers(appId, chatId)
  }

  private drop(paths: string[] | null): void {
    for (const path of paths ?? []) {
      const inside = relative(this.options.attachmentsDirectory, path)
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) continue
      try {
        rmSync(path, { force: true })
      } catch (error) {
        this.options.log(`飞书附件删除失败：${(error as Error).message}`)
      }
    }
  }

  // —— 历史接口 ——

  /** 限流时按平台给的时间等一会儿再试 */
  private async retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work()
      } catch (error) {
        if (!(error instanceof FeishuApiError) || error.kind !== 'rate_limited') throw error
        if (attempt >= RATE_RETRIES) throw error
        const wait = Math.min(RATE_WAIT_MAX_MS, Math.max(500, (error.retryAt ?? 0) - Date.now()))
        await sleep(wait)
      }
    }
  }

  /** 翻一段历史（秒），最多 limit 条；返回条目和窗口里是否还有没翻完的 */
  private async history(
    api: FeishuApi,
    chatId: string,
    window: { start: number; end: number },
    order: 'asc' | 'desc',
    limit: number,
    stillWanted: () => boolean,
  ): Promise<{ items: Incoming[]; more: boolean }> {
    const items: Incoming[] = []
    let pageToken = ''
    for (;;) {
      if (!stillWanted()) return { items, more: false }
      const query: Record<string, string | number> = {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: window.start,
        end_time: window.end,
        sort_type: order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
        page_size: PAGE_SIZE,
      }
      if (pageToken) query.page_token = pageToken
      const data = await this.retry(() => api.data('GET', '/open-apis/im/v1/messages', { query }))
      for (const raw of Array.isArray(data.items) ? data.items : []) {
        if (!isObject(raw)) continue
        const incoming = fromHistory(raw)
        if (!incoming || incoming.chatId !== chatId) continue
        if (items.length >= limit) return { items, more: true }
        items.push(incoming)
      }
      pageToken = data.has_more === true ? text(data.page_token, 512) : ''
      if (!pageToken) return { items, more: false }
      if (items.length >= limit) return { items, more: true }
    }
  }

  // —— 补历史 ——

  /** 接入、改设置之后：记下保留天数；新接入的补最近 7 天、同步成员表 */
  accessChanged(chat: FeishuChatRecord, first: boolean): void {
    const access = chat.access
    if (!access) return
    this.messages.patchSync(chat.appId, chat.chatId, access.retentionDays, (sync) => ({
      ...sync,
      retentionDays: access.retentionDays,
    }))
    if (!first) return
    const end = access.accessAt
    this.startBackfill(chat.appId, chat.chatId, end - ACCESS_BACKFILL_DAYS * DAY, end, 'access')
    void this.enqueue(chat.appId, () => this.syncMembers(chat.appId, chat.chatId))
  }

  /** 手动补一段（秒）；补的进度在群的 records.backfill 里 */
  backfill(appId: string, chatId: string, start: number, end: number): void {
    const { chats } = this.options
    const chat = chats.record(appId, chatId) ?? this.options.fail('feishu_chat_not_found')
    if (!chat.access) this.options.fail('feishu_chat_not_accessed')
    if (!chats.active(appId, chatId)) this.options.fail('feishu_chat_unavailable')
    if (!this.options.api(appId)) this.options.fail('feishu_app_inactive')
    if (this.messages.sync(appId, chatId)?.backfill?.state === 'running')
      this.options.fail('feishu_backfill_running')
    const now = this.options.now()
    if (start >= end || start > now) this.options.fail('feishu_backfill_window_invalid')
    this.startBackfill(appId, chatId, start, Math.min(end, now), 'manual')
  }

  private startBackfill(
    appId: string,
    chatId: string,
    start: number,
    end: number,
    kind: 'access' | 'manual',
  ): void {
    const startedAt = this.options.now()
    this.messages.patchSync(appId, chatId, this.retentionOf(appId, chatId), (sync) => ({
      ...sync,
      backfill: { kind, state: 'running', start, end, fetched: 0, truncated: false, startedAt },
    }))
    this.changed(appId, chatId)
    void this.enqueue(appId, async () => {
      const finish = (patch: { state: 'done' | 'failed'; fetched: number; truncated: boolean }) => {
        // 补到一半取消接入并删了记录：水位行已经没了，不再写回
        if (!this.messages.sync(appId, chatId)) return
        this.messages.patchSync(appId, chatId, this.retentionOf(appId, chatId), (sync) => ({
          ...sync,
          backfill: { kind, start, end, startedAt, ...patch, finishedAt: this.options.now() },
        }))
        this.changed(appId, chatId)
      }
      const api = this.options.api(appId)
      if (!api) return finish({ state: 'failed', fetched: 0, truncated: false })
      try {
        // 先倒着翻到上限或窗口起点，留最新的那些，再按时间先后入库
        const { items, more } = await this.history(
          api,
          chatId,
          { start, end },
          'desc',
          FEISHU_BACKFILL_LIMIT,
          () => this.options.chats.active(appId, chatId),
        )
        if (!this.options.chats.active(appId, chatId))
          return finish({ state: 'failed', fetched: 0, truncated: false })
        for (const incoming of items.reverse()) this.store(appId, incoming, 'backfill')
        finish({ state: 'done', fetched: items.length, truncated: more })
      } catch (error) {
        this.options.log(`飞书补历史失败：${(error as Error).message}`)
        finish({ state: 'failed', fetched: 0, truncated: false })
      }
    })
  }

  /** 每次连上：每个已接入的群补断线期间的消息，顺便对一遍成员表 */
  connected(appId: string): void {
    for (const chat of this.options.chats.activeChats(appId)) {
      void this.enqueue(appId, () => this.fillGap(appId, chat.chatId))
      void this.enqueue(appId, () => this.syncMembers(appId, chat.chatId))
    }
  }

  private async fillGap(appId: string, chatId: string): Promise<void> {
    const api = this.options.api(appId)
    const chat = this.options.chats.record(appId, chatId)
    if (!api || !chat?.access || !this.options.chats.active(appId, chatId)) return
    const sync = this.messages.sync(appId, chatId)
    const from = (sync?.liveWatermark ?? chat.access.accessAt * 1000) - GAP_OVERLAP_MS
    const start = Math.max(0, Math.floor(from / 1000))
    const end = this.options.now()
    if (start >= end) return
    const { items, more } = await this.history(
      api,
      chatId,
      { start, end },
      'asc',
      FEISHU_BACKFILL_LIMIT,
      () => this.options.chats.active(appId, chatId),
    )
    let fetched = 0
    let watermark = sync?.liveWatermark ?? 0
    for (const incoming of items) {
      if (this.store(appId, incoming, 'gap')) fetched += 1
      watermark = Math.max(watermark, incoming.createTime)
    }
    if (!this.messages.sync(appId, chatId) && !this.options.chats.active(appId, chatId)) return
    this.messages.patchSync(appId, chatId, this.retentionOf(appId, chatId), (current) => ({
      ...current,
      ...(watermark > 0 ? { liveWatermark: watermark } : {}),
      gap: { at: end, start, end, fetched, complete: !more },
    }))
    this.changed(appId, chatId)
  }

  private async syncMembers(appId: string, chatId: string): Promise<void> {
    if (!this.options.chats.active(appId, chatId)) return
    try {
      const { members, fetchedAt } = await this.options.chats.memberList(appId, chatId, true)
      if (!this.options.chats.active(appId, chatId)) return
      this.messages.saveMembers(appId, chatId, members, fetchedAt, true)
      this.messages.patchSync(appId, chatId, this.retentionOf(appId, chatId), (sync) => ({
        ...sync,
        membersSyncedAt: fetchedAt,
      }))
    } catch (error) {
      this.options.log(`飞书成员表同步失败：${(error as Error).message}`)
    }
  }

  // —— 按需读单条 ——

  /** 回源读一条消息并按最新版存下（本地没有的记 source=fetch）；读不到返回本地那行或 null */
  async fetchMessage(appId: string, messageId: string): Promise<StoredMessage | null> {
    const api = this.options.api(appId)
    if (!api) return this.messages.get(appId, messageId)
    const item = (await this.detail(api, messageId, false))[0]
    const incoming = item ? fromHistory(item) : null
    if (incoming && this.options.chats.record(appId, incoming.chatId)?.access)
      this.store(appId, incoming, 'fetch')
    return this.messages.get(appId, messageId)
  }

  // —— 附件 ——

  /** 下载一条已记录消息的附件到私有目录；同一附件只下一次 */
  async download(appId: string, messageId: string, fileKey: string): Promise<StoredAttachment> {
    const { messages, fail } = this.options
    const message = messages.get(appId, messageId) ?? fail('feishu_message_not_found')
    if (!this.options.chats.record(appId, message.chatId)?.access) fail('feishu_chat_not_accessed')
    const attachment =
      messages.attachments(appId, messageId).find((one) => one.fileKey === fileKey) ??
      fail('feishu_attachment_not_found')
    if (attachment.downloadedPath) {
      try {
        if (statSync(attachment.downloadedPath).isFile()) return attachment
      } catch {
        // 文件被删了：重新下
      }
    }
    if (message.state !== 'normal') fail('feishu_message_unavailable')
    const api = this.options.api(appId) ?? fail('feishu_app_inactive')
    // 不排进历史请求的队列：经理在等，不能卡在一次补历史后面
    const { bytes, type } = await this.retry(() =>
      api.download(
        `/open-apis/im/v1/messages/${encodeURIComponent(attachment.resourceMessageId)}/resources/${encodeURIComponent(fileKey)}`,
        { type: attachment.kind === 'image' ? 'image' : 'file' },
      ),
    )
    const directory = join(this.options.attachmentsDirectory, safeName(appId), safeName(messageId))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(this.options.attachmentsDirectory, 0o700)
    const path = join(directory, `${safeName(fileKey)}-${safeName(attachment.name) || 'file'}`)
    writeFileSync(path, bytes, { mode: 0o600 })
    const saved: StoredAttachment = {
      ...attachment,
      size: bytes.length,
      ...(type ? { contentType: type.split(';')[0]?.trim() || type } : {}),
      downloadedPath: path,
      downloadedAt: this.options.now(),
    }
    messages.saveDownload(appId, messageId, saved)
    return saved
  }

  // —— 回源补全 ——

  private enrichLater(appId: string, messageId: string, content: ParsedContent): void {
    void this.enqueue(appId, async () => {
      const api = this.options.api(appId)
      if (!api) return
      try {
        await this.enrich(api, appId, messageId, content)
      } catch (error) {
        this.options.log(`飞书消息回源失败：${(error as Error).message}`)
      }
    })
  }

  private async detail(api: FeishuApi, messageId: string, card: boolean): Promise<Json[]> {
    const data = await this.retry(() =>
      api.data('GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        // 卡片要原始 JSON，事件里给的是丢了正文的简化结构
        query: card ? { card_msg_content_type: 'user_card_content' } : {},
      }),
    )
    return Array.isArray(data.items) ? data.items.filter(isObject) : []
  }

  private async enrich(
    api: FeishuApi,
    appId: string,
    messageId: string,
    content: ParsedContent,
  ): Promise<void> {
    const current = this.messages.get(appId, messageId)
    if (!current || current.state !== 'normal') return
    if (content.detail === 'interactive') {
      const item = (await this.detail(api, messageId, true))[0]
      const card = item && isObject(item.body) ? cardText(item.body.content) : ''
      if (card) this.messages.rewrite(appId, messageId, { text: clip(card) })
      return
    }
    if (content.detail === 'merge_forward') {
      const items = await this.detail(api, messageId, false)
      const children: ForwardChild[] = []
      let cards = 0
      for (const item of items) {
        const childId = text(item.message_id, 128)
        const msgType = text(item.msg_type, 64)
        const child: ForwardChild = {
          messageId: childId,
          msgType,
          content: isObject(item.body) ? item.body.content : '',
          mentions: mentionRefs(mentionsOf(item.mentions)),
        }
        if (msgType === 'interactive' && childId !== messageId && cards < FORWARD_CARD_FETCH) {
          cards += 1
          const card = (await this.detail(api, childId, true))[0]
          const value = card && isObject(card.body) ? cardText(card.body.content) : ''
          if (value) child.cardText = value
        }
        children.push(child)
      }
      const expanded = expandForward(messageId, children)
      this.messages.rewrite(appId, messageId, { text: clip(expanded.text) }, expanded.attachments)
      return
    }
    if (content.detail === 'share_chat' && content.sharedId) {
      const data = await this.retry(() =>
        api.data('GET', `/open-apis/im/v1/chats/${encodeURIComponent(content.sharedId ?? '')}`),
      )
      const name = text(data.name)
      if (name) this.messages.rewrite(appId, messageId, { text: `[群名片] ${name}` })
      return
    }
    if (content.detail === 'share_user' && content.sharedId) {
      const openId = content.sharedId
      let name = this.messages.memberName(appId, current.chatId, openId) ?? ''
      if (!name) {
        try {
          const data = await this.retry(() =>
            api.data('GET', `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`, {
              query: { user_id_type: 'open_id' },
            }),
          )
          name = isObject(data.user) ? text(data.user.name) : ''
        } catch {
          // 不在通讯录范围内：保留 ID
        }
      }
      if (name) this.messages.rewrite(appId, messageId, { text: `[个人名片] ${name}` })
    }
  }

  // —— 取消接入与清理 ——

  unaccessed(appId: string, chatId: string, deleteRecords: boolean): void {
    if (deleteRecords) {
      this.drop(this.messages.forgetChat(appId, chatId, this.options.now()))
      return
    }
    // 留着记录：照接入时的保留天数继续清理；正在补的历史停下
    const sync = this.messages.sync(appId, chatId)
    if (sync?.backfill?.state === 'running')
      this.messages.saveSync(appId, chatId, {
        ...sync,
        backfill: { ...sync.backfill, state: 'failed', finishedAt: this.options.now() },
      })
  }

  /** 按每个群的保留天数删旧消息 */
  purgeAll(): void {
    const now = this.options.now()
    for (const { appId, chatId, sync } of this.messages.syncedChats()) {
      try {
        const days = this.options.chats.record(appId, chatId)?.access?.retentionDays
        const cutoff = (now - (days ?? sync.retentionDays) * DAY) * 1000
        this.drop(this.messages.purge(appId, chatId, now, cutoff))
      } catch (error) {
        this.options.log(`飞书记录清理失败：${(error as Error).message}`)
      }
    }
  }
}
