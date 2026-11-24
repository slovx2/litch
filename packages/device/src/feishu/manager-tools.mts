// 经理的飞书工具（litch_feishu）：设备执行，按调用的会话认出经理，只能用它绑定的应用、只看已接入的群。

import { randomUUID } from 'node:crypto'
import {
  type ClientToolCallResponse,
  clientToolFailure,
} from '../../../protocol/src/client-tools.mjs'
import { FEISHU_TOOL } from '../../../protocol/src/client-tools-feishu.mjs'
import type { FeishuInboxEntry } from '../../../protocol/src/feishu.mjs'
import { FEISHU_OPERATION_ID } from '../../../protocol/src/feishu.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'
import type { DeviceToolCall, DeviceToolHandler } from '../device-tools.mjs'
import { isObject } from '../wire.mjs'
import type { FeishuChatRecord } from './chats.mjs'
import { escapeExternal, FEISHU_DATA_NOTE, messageLine } from './format.mjs'
import { type OutboxRecord, OutboxRefusal } from './outbox.mjs'
import type { DeviceFeishuService } from './service.mjs'
import type { FeishuAppRecord } from './store.mjs'

const HISTORY_DEFAULT = 50
const HISTORY_MAX = 100
const REFRESH_MAX = 50
const LIST_DEFAULT = 50

class ToolError extends Error {}
const refuse = (message: string): never => {
  throw new ToolError(message)
}

const ok = (value: unknown): ClientToolCallResponse => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
})

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

/** ISO 时间转毫秒；不认识的拒绝 */
const time = (value: unknown, field: string): number | undefined => {
  if (value === undefined) return undefined
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : refuse(`${field} must be an ISO 8601 time.`)
}

const strings = (value: unknown, field: string, pattern: RegExp, max: number) => {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > max ||
    !value.every((one) => typeof one === 'string' && pattern.test(one))
  )
    return refuse(`${field} must be a non-empty list of at most ${max} valid IDs.`)
  return [...new Set(value as string[])]
}

const integer = (value: unknown, field: string, max: number, fallback: number) => {
  if (value === undefined) return fallback
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= max
    ? Number(value)
    : refuse(`${field} must be an integer from 1 to ${max}.`)
}

export interface FeishuToolsHost {
  /** 调用的会话就是一位在职经理时返回它；工作线、临时提问会话返回 null */
  manager(call: DeviceToolCall): Manager | null
}

export class FeishuManagerTools {
  private readonly feishu: DeviceFeishuService
  private readonly host: FeishuToolsHost
  /** 每位经理上次列出的那批（feishu_inbox_done 缺省标记它）；at 是秒 */
  private readonly listed = new Map<string, { inboxIds: string[]; at: number }>()

  constructor(feishu: DeviceFeishuService, host: FeishuToolsHost) {
    this.feishu = feishu
    this.host = host
  }

  readonly handle: DeviceToolHandler = async (call) => {
    try {
      const manager =
        this.host.manager(call) ?? refuse('Only an active manager may use litch_feishu.')
      const app =
        this.feishu.appForManager(manager.id) ??
        refuse('No Feishu app is assigned to this manager.')
      const args = call.arguments === undefined ? {} : call.arguments
      if (!isObject(args)) return refuse('Expected structured arguments.')
      return ok(await this.run(call.tool, manager, app, args, call))
    } catch (error) {
      if (error instanceof ToolError || error instanceof OutboxRefusal)
        return clientToolFailure('invalid', error.message)
      const reason = (error as Error).message
      return clientToolFailure('invalid', `Feishu request failed: ${reason}`)
    }
  }

  private async run(
    tool: string,
    manager: Manager,
    app: FeishuAppRecord,
    args: Record<string, unknown>,
    call: DeviceToolCall,
  ): Promise<unknown> {
    switch (tool) {
      case FEISHU_TOOL.inboxList:
        return this.inboxList(manager, app, args)
      case FEISHU_TOOL.inboxDone:
        return this.inboxDone(manager, app, args)
      case FEISHU_TOOL.chats:
        return this.chats(app)
      case FEISHU_TOOL.members:
        return this.members(app, args)
      case FEISHU_TOOL.history:
        return this.history(app, args)
      case FEISHU_TOOL.attachment:
        return this.attachment(app, args)
      case FEISHU_TOOL.messageRef:
        return this.messageRef(app, args)
      case FEISHU_TOOL.send:
        return this.send(manager, app, args, call)
      case FEISHU_TOOL.sendGet:
        return this.sendView(manager, args)
      case FEISHU_TOOL.sendCancel:
        return this.sendCancel(manager, args)
      case FEISHU_TOOL.userGrantRequest:
        return this.userGrantRequest(app, args)
      default:
        return refuse(`Unknown litch_feishu tool ${tool}.`)
    }
  }

  private inboxList(manager: Manager, app: FeishuAppRecord, args: Record<string, unknown>) {
    const allowed = ['queued', 'notified', 'processed'] as const
    const statuses = (args.statuses ?? ['queued', 'notified']) as FeishuInboxEntry['status'][]
    if (
      !Array.isArray(statuses) ||
      statuses.length === 0 ||
      !statuses.every((one) => (allowed as readonly string[]).includes(one))
    )
      refuse('statuses must be a non-empty subset of queued, notified, processed.')
    const limit = integer(args.limit, 'limit', 100, LIST_DEFAULT)
    const { inbox, messages, chats } = this.feishu
    const entries = inbox
      .list(manager.id, [...new Set(statuses)], limit)
      .filter((entry) => entry.appId === app.appId)
    this.listed.set(manager.id, {
      inboxIds: entries.map((entry) => entry.inboxId),
      at: this.feishu.now(),
    })
    return {
      note: FEISHU_DATA_NOTE,
      entries: entries.map((entry) => {
        const message = messages.get(app.appId, entry.messageId)
        return {
          inboxId: entry.inboxId,
          status: entry.status,
          chat:
            entry.chatKind === 'p2p'
              ? { chatId: entry.chatId, direct: true, user: entry.senderOpenId }
              : { chatId: entry.chatId, name: chats.record(app.appId, entry.chatId)?.name ?? '' },
          sender: {
            openId: entry.senderOpenId,
            ...(entry.senderName ? { name: entry.senderName } : {}),
            identity: entry.senderIdentity,
          },
          trigger: entry.trigger,
          messageId: entry.messageId,
          createdAt: iso(entry.createdAt),
          text: message ? messageLine(messages, app.appId, message) : '[message not recorded]',
          ...(entry.processedAt ? { processedAt: iso(entry.processedAt) } : {}),
          ...(entry.note ? { note: entry.note } : {}),
        }
      }),
    }
  }

  private inboxDone(manager: Manager, app: FeishuAppRecord, args: Record<string, unknown>) {
    const given = strings(args.inboxIds, 'inboxIds', /^FI-[1-9][0-9]*$/, 200)
    let inboxIds: string[] = given ?? []
    if (!given) {
      // 缺省：上次列出的和上次送进回合的，取更近的那次，不碰之后才到的
      const listed = this.listed.get(manager.id)
      const delivered = this.feishu.wake.lastDelivered(manager.id)
      const latest =
        listed && (!delivered || listed.at >= delivered.at) ? listed : (delivered ?? null)
      inboxIds = latest?.inboxIds ?? []
      if (inboxIds.length === 0) refuse('Nothing was listed or delivered yet; pass inboxIds.')
    }
    const { inbox } = this.feishu
    const now = this.feishu.now()
    const changed = this.feishu.store.transaction(() =>
      inbox.transition(manager.id, inboxIds, ['queued', 'notified'], 'processed', {
        processedAt: now,
        note: undefined,
      }),
    )
    if (changed.length > 0) this.feishu.inboxChanged(manager.id, app.appId)
    const done = new Set(changed.map((entry) => entry.inboxId))
    return {
      processed: [...done],
      skipped: inboxIds.filter((id) => !done.has(id)),
    }
  }

  private accessed(app: FeishuAppRecord, value: unknown): FeishuChatRecord {
    if (typeof value !== 'string' || !value.trim()) return refuse('chat is required.')
    const chats = this.feishu.chats.activeChats(app.appId).filter((chat) => chat.access)
    const byId = chats.find((chat) => chat.chatId === value)
    if (byId) return byId
    const named = chats.filter((chat) => chat.name === value.trim())
    if (named.length === 1 && named[0]) return named[0]
    if (named.length > 1)
      return refuse(
        `Several accessed chats are named ${value}: ${named.map((chat) => chat.chatId).join(', ')}. Use chat_id.`,
      )
    return refuse(`No accessed chat matches ${value}.`)
  }

  /** 已绑定的人（私聊）：open_id 或名字，重名的拒绝 */
  private boundUser(
    app: FeishuAppRecord,
    value: unknown,
  ): { openId: string; name: string; chatId: string } {
    if (typeof value !== 'string' || !value.trim()) return refuse('user is required.')
    const users = this.feishu.bindings
      .records(app.appId)
      .filter((one) => one.state === 'bound' && one.p2pChatId)
    const byId = users.find((one) => one.openId === value.trim())
    const named = byId ? [byId] : users.filter((one) => one.name && one.name === value.trim())
    if (named.length > 1)
      return refuse(
        `Several bound users are named ${value}: ${named.map((one) => one.openId).join(', ')}. Use the open_id.`,
      )
    const found = named[0]
    if (!found?.p2pChatId) return refuse(`No bound user matches ${value}.`)
    return { openId: found.openId, name: found.name, chatId: found.p2pChatId }
  }

  /** 发起用户身份授权：链接和用户码交给经理转给本人 */
  private async userGrantRequest(app: FeishuAppRecord, args: Record<string, unknown>) {
    const user = this.boundUser(app, args.user)
    const reason = typeof args.reason === 'string' ? args.reason.slice(0, 500) : ''
    let grant: Awaited<ReturnType<DeviceFeishuService['grants']['invite']>>
    try {
      grant = await this.feishu.grants.invite(app.appId, user.openId, `tool-${randomUUID()}`, {
        via: 'manager_tool',
        ...(reason ? { reason } : {}),
      })
    } catch (error) {
      const code = (error as Error).message
      return refuse(
        code === 'feishu_user_scopes_missing'
          ? 'The Feishu app has no user-identity permissions yet; an admin must apply for them in Litch (app details, capability check).'
          : `Could not start the grant (${code}).`,
      )
    }
    return {
      user: { openId: user.openId, name: user.name },
      verificationUrl: grant.pending?.verificationUrl,
      userCode: grant.pending?.userCode,
      expiresAt: grant.pending?.expiresAt,
      note: 'Only this person can approve, by opening the link in Feishu. After granting, lark-cli can act as them with every user permission the app has enabled (not only those Litch requests), including reading all of their Feishu chats; sending still goes through the chat approval rules and auth endpoints are refused. Check the result later with feishu_chats (userIdentity).',
    }
  }

  private chats(app: FeishuAppRecord) {
    const { chats, messages } = this.feishu
    return {
      users: this.feishu.bindings
        .records(app.appId)
        .filter((one) => one.state === 'bound')
        .map((one) => ({
          openId: one.openId,
          name: one.name,
          // 能不能用 LITCH_FEISHU_AS_USER 以他的身份
          userIdentity: this.feishu.grants.get(app.appId, one.openId)?.state ?? 'none',
        })),
      chats: chats
        .activeChats(app.appId)
        .filter((chat) => chat.access)
        .map((chat) => {
          const view = chats.view(chat)
          return {
            chatId: chat.chatId,
            name: chat.name,
            speech: view.access?.speech,
            external: chat.external,
            members: messages.members(app.appId, chat.chatId).filter((one) => one.present).length,
          }
        }),
    }
  }

  private async members(app: FeishuAppRecord, args: Record<string, unknown>) {
    const chat = this.accessed(app, args.chat)
    const local = this.feishu.messages
      .members(app.appId, chat.chatId)
      .filter((one) => one.present)
      .map(({ openId, name }) => ({ openId, name }))
    const members =
      local.length > 0
        ? local
        : (await this.feishu.chats.memberList(app.appId, chat.chatId, false)).members.map(
            ({ openId, name }) => ({ openId, name }),
          )
    return { chatId: chat.chatId, name: chat.name, members }
  }

  private async history(app: FeishuAppRecord, args: Record<string, unknown>) {
    if ((args.chat === undefined) === (args.user === undefined)) refuse('Give either chat or user.')
    const chat =
      args.chat !== undefined
        ? this.accessed(app, args.chat)
        : (() => {
            const user = this.boundUser(app, args.user)
            return { chatId: user.chatId, name: `Direct message with ${user.name || user.openId}` }
          })()
    const since = time(args.since, 'since')
    const until = time(args.until, 'until')
    if (args.keyword !== undefined && typeof args.keyword !== 'string')
      refuse('keyword must be a string.')
    const messageIds = strings(args.messageIds, 'messageIds', /^om_/, HISTORY_MAX)
    const limit = integer(args.limit, 'limit', HISTORY_MAX, HISTORY_DEFAULT)
    const { messages, records } = this.feishu
    const filter = {
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until: until - 1 }),
      ...(typeof args.keyword === 'string' && args.keyword ? { keyword: args.keyword } : {}),
      ...(messageIds ? { messageIds } : {}),
    }
    let found = messages.search(app.appId, chat.chatId, filter, limit)
    if (args.refresh === true) {
      for (const message of found.slice(-REFRESH_MAX))
        await records.fetchMessage(app.appId, message.messageId)
      found = messages.search(app.appId, chat.chatId, filter, limit)
    }
    return {
      chatId: chat.chatId,
      name: chat.name,
      count: found.length,
      text: [
        '<litch-external-data source="feishu">',
        `## ${escapeExternal(chat.name)} (${chat.chatId})`,
        FEISHU_DATA_NOTE,
        ...found.map((message) => messageLine(messages, app.appId, message)),
        '</litch-external-data>',
      ].join('\n'),
    }
  }

  private async attachment(app: FeishuAppRecord, args: Record<string, unknown>) {
    if (typeof args.messageId !== 'string' || !/^om_/.test(args.messageId))
      refuse('messageId is required.')
    if (typeof args.fileKey !== 'string' || !args.fileKey) refuse('fileKey is required.')
    const saved = await this.feishu.records.download(
      app.appId,
      String(args.messageId),
      String(args.fileKey),
    )
    return {
      path: saved.downloadedPath,
      size: saved.size,
      kind: saved.kind,
      name: saved.name,
      ...(saved.contentType ? { contentType: saved.contentType } : {}),
    }
  }

  private messageRef(app: FeishuAppRecord, args: Record<string, unknown>) {
    if (typeof args.messageId !== 'string' || !/^om_/.test(args.messageId))
      refuse('messageId is required.')
    if (typeof args.issueId !== 'string' || !/^X-[1-9][0-9]*$/.test(args.issueId))
      refuse('issueId must be an item ID like X-1.')
    const message =
      this.feishu.messages.get(app.appId, String(args.messageId)) ??
      refuse('The message is not recorded on this device.')
    this.feishu.messages.pin(app.appId, message.messageId)
    return { messageId: message.messageId, issueId: args.issueId, kept: true }
  }

  private async send(
    manager: Manager,
    app: FeishuAppRecord,
    args: Record<string, unknown>,
    call: DeviceToolCall,
  ) {
    const optionalText = (field: string): string | undefined => {
      const value = args[field]
      if (value === undefined) return undefined
      return typeof value === 'string' ? value : refuse(`${field} must be a string.`)
    }
    if ((args.chat === undefined) === (args.user === undefined)) refuse('Give either chat or user.')
    let target: { kind: 'chat'; chatId: string } | { kind: 'user'; openId: string }
    if (args.chat !== undefined)
      target = { kind: 'chat', chatId: this.accessed(app, args.chat).chatId }
    else target = { kind: 'user', openId: this.boundUser(app, args.user).openId }
    const format = args.format
    if (format !== undefined && !['auto', 'text', 'post', 'card'].includes(String(format)))
      refuse('format must be auto, text, post or card.')
    const mentions = args.mentions
    if (
      mentions !== undefined &&
      (!Array.isArray(mentions) || !mentions.every((one) => typeof one === 'string' && one.trim()))
    )
      refuse('mentions must be a list of names or open_ids.')
    const operationId = optionalText('operationId')
    if (operationId !== undefined && !FEISHU_OPERATION_ID.test(operationId))
      refuse('operationId must be 8 to 40 letters, digits, _ or -.')
    const replyTo = optionalText('replyTo')
    const text = optionalText('text')
    const title = optionalText('title')
    const imagePath = optionalText('imagePath')
    const filePath = optionalText('filePath')
    const record = await this.feishu.outbox.submit({
      app,
      managerId: manager.id,
      threadId: call.threadId,
      turnId: call.turnId,
      target,
      ...(operationId ? { operationId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(format !== undefined ? { format: format as 'auto' | 'text' | 'post' | 'card' } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(imagePath !== undefined ? { imagePath } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
      ...(Array.isArray(mentions) ? { mentions: mentions as string[] } : {}),
    })
    return this.describe(record)
  }

  private owned(manager: Manager, args: Record<string, unknown>): OutboxRecord {
    const operationId = args.operationId
    if (typeof operationId !== 'string' || !FEISHU_OPERATION_ID.test(operationId))
      return refuse('operationId is required.')
    const record = this.feishu.outbox.get(operationId)
    if (!record || record.managerId !== manager.id) return refuse('No such send operation.')
    return record
  }

  private sendView(manager: Manager, args: Record<string, unknown>) {
    return this.describe(this.owned(manager, args))
  }

  private sendCancel(manager: Manager, args: Record<string, unknown>) {
    const record = this.owned(manager, args)
    return this.describe(this.feishu.outbox.cancel(record.operationId, 'manager'))
  }

  /** 给经理看的发件状态：带审批状态和下一步该怎么做 */
  private describe(record: OutboxRecord) {
    const review = record.reviewId ? this.feishu.options.reviews?.get(record.reviewId) : null
    const notes: Record<string, string> = {
      queued: 'Queued; the device sends it shortly.',
      sending: 'Being sent now.',
      awaiting_approval: `Waiting for approval ${record.reviewId}. Do not resend; the result comes in a later delivery or via feishu_send_get.`,
      sent: 'Sent.',
      failed: 'Not sent.',
      rejected: 'The approver rejected it; it was not sent.',
      canceled: 'Withdrawn or expired before sending; it was not sent.',
      unknown:
        record.nextAttemptAt === undefined
          ? 'Unclear whether it was sent; automatic retries stopped. Check the chat history before sending again.'
          : 'The last attempt had an unclear result; the device retries with the same ID.',
    }
    return {
      operationId: record.operationId,
      state: record.state,
      note: notes[record.state],
      target: record.target,
      format: record.format,
      parts: record.parts,
      messageIds: record.messageIds,
      ...(record.replyTo ? { replyTo: record.replyTo } : {}),
      ...(record.mentions.length ? { mentions: record.mentions } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(review
        ? {
            review: {
              reviewId: review.reviewId,
              state: review.state,
              ...(review.reason ? { reason: review.reason } : {}),
              expiresAt: iso(review.expiresAt),
            },
          }
        : {}),
      createdAt: iso(record.createdAt),
      ...(record.sentAt ? { sentAt: iso(record.sentAt) } : {}),
    }
  }
}
