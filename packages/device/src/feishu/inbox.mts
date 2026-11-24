// 飞书收件箱（D-158、D-161、D-166、D-170、D-173）：群里和私聊里谁找了经理。
// 私聊：已绑定的人发的每一条都进收件箱（没绑定的人的私聊根本不落库）。
// 群：消息落库后同步判定（处理函数返回、SDK 回 ACK 之前就写进收件箱），条件是：
// 1. 找的是机器人：@ 了机器人（按 open_id 精确比较），或回复的是机器人发的消息；
// 2. 发送人在本群的叫醒名单里：手选的成员，加上开关开着时本应用全部已绑定用户。
// 回复的那条本地没有时先标“待分拣”，后台回源读一次再判；设备重启时把待分拣的重新判一遍。
// 收件箱只存消息 ID 和判定结果，不存正文；正文在消息库里，进了收件箱的消息过保留期只清正文。
import type { FeishuInboxEntry, FeishuInboxTrigger } from '../../../protocol/src/feishu.mjs'
import type { FeishuChats } from './chats.mjs'
import type { ImMessages, MessageSource, StoredMessage } from './messages.mjs'
import type { FeishuRecords } from './records.mjs'
import type { FeishuStore } from './store.mjs'

export const FEISHU_INBOX_MIGRATION = `
CREATE TABLE feishu_inbox(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, message_id TEXT NOT NULL,
  manager_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(app_id, message_id)
);
CREATE INDEX feishu_inbox_manager ON feishu_inbox(manager_id, status, seq);
CREATE TABLE feishu_context_cursor(
  manager_id TEXT NOT NULL, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, last_seq INTEGER NOT NULL,
  PRIMARY KEY(manager_id, app_id, chat_id)
);
CREATE TABLE feishu_deliveries(
  delivery_id TEXT PRIMARY KEY, manager_id TEXT NOT NULL, app_id TEXT NOT NULL, at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX feishu_deliveries_app ON feishu_deliveries(app_id, at);
`

/** 补缺口补到的找机器人的消息，只有 24 小时内的进收件箱（D-173） */
const GAP_INBOX_WINDOW = 86_400

export interface FeishuInboxOptions {
  store: FeishuStore
  messages: ImMessages
  chats: FeishuChats
  records: FeishuRecords
  /** 秒 */
  now: () => number
  log: (message: string) => void
  /** 收件箱变了（新条目、送达、处理完） */
  changed: (managerId: string, appId: string) => void
}

/** 已绑定用户（私聊绑定挂进来）；没绑定的是 null */
export type FeishuBoundLookup = (appId: string, openId: string) => { name: string } | null

type InboxBody = Omit<FeishuInboxEntry, 'inboxId' | 'status'>

export class FeishuInbox {
  private readonly options: FeishuInboxOptions
  /** 每条进收件箱后通知投递（排定叫醒时间） */
  private readonly queuedHooks: ((managerId: string) => void)[] = []
  bound: FeishuBoundLookup = () => null

  constructor(options: FeishuInboxOptions) {
    this.options = options
  }

  private get db() {
    return this.options.store.managers.db
  }

  onQueued(hook: (managerId: string) => void): void {
    this.queuedHooks.push(hook)
  }

  // —— 存取 ——

  private entryOf(row: Record<string, unknown>): FeishuInboxEntry {
    return {
      inboxId: `FI-${Number(row.seq)}`,
      status: String(row.status) as FeishuInboxEntry['status'],
      ...(JSON.parse(String(row.body)) as InboxBody),
    }
  }

  entry(inboxId: string): FeishuInboxEntry | null {
    const seq = /^FI-([1-9][0-9]*)$/.exec(inboxId)?.[1]
    if (!seq) return null
    const row = this.db.prepare('SELECT * FROM feishu_inbox WHERE seq=?').get(Number(seq))
    return row ? this.entryOf(row) : null
  }

  list(
    managerId: string,
    statuses: FeishuInboxEntry['status'][],
    limit = 100,
    beforeSeq?: number,
  ): FeishuInboxEntry[] {
    if (statuses.length === 0) return []
    return this.db
      .prepare(
        `SELECT * FROM feishu_inbox WHERE manager_id=? AND status IN (${statuses.map(() => '?').join(',')})
         ${beforeSeq === undefined ? '' : 'AND seq<?'} ORDER BY seq DESC LIMIT ?`,
      )
      .all(managerId, ...statuses, ...(beforeSeq === undefined ? [] : [beforeSeq]), limit)
      .map((row) => this.entryOf(row))
  }

  /** 有排队条目的经理 */
  queuedManagers(): string[] {
    return this.db
      .prepare("SELECT DISTINCT manager_id FROM feishu_inbox WHERE status='queued'")
      .all()
      .map((row) => String(row.manager_id))
  }

  /** 改状态；只改给定经理名下、当前在 from 里的那些，返回改了的 */
  transition(
    managerId: string,
    inboxIds: string[],
    from: FeishuInboxEntry['status'][],
    to: FeishuInboxEntry['status'],
    /** 值为 undefined 的键表示去掉 */
    patch: { [K in keyof InboxBody]?: InboxBody[K] | undefined } = {},
  ): FeishuInboxEntry[] {
    const changed: FeishuInboxEntry[] = []
    for (const inboxId of inboxIds) {
      const current = this.entry(inboxId)
      if (!current || current.managerId !== managerId || !from.includes(current.status)) continue
      const { inboxId: _id, status: _status, ...body } = current
      const merged: Record<string, unknown> = { ...body, ...patch }
      for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
      const next = merged as InboxBody
      this.db
        .prepare('UPDATE feishu_inbox SET status=?, body=? WHERE seq=?')
        .run(to, JSON.stringify(next), Number(inboxId.slice(3)))
      changed.push({ ...next, inboxId, status: to })
    }
    return changed
  }

  // —— 判定 ——

  /** 消息落库后的钩子：判要不要进收件箱 */
  stored(message: StoredMessage, source: MessageSource): void {
    if (source !== 'event' && source !== 'gap') return
    if (message.senderType !== 'user') return
    if (source === 'gap' && message.createTime < (this.options.now() - GAP_INBOX_WINDOW) * 1000)
      return
    if (message.chatKind === 'p2p') this.direct(message)
    else this.judge(message)
  }

  /** 私聊：发送人还绑着就进收件箱 */
  private direct(message: StoredMessage): void {
    const app = this.options.store.app(message.appId)
    if (!app?.managerId || !app.enabled) return
    const bound = this.bound(message.appId, message.senderId)
    if (bound) this.enqueue(message, app.managerId, 'p2p', bound)
  }

  private judge(message: StoredMessage): void {
    const { store, chats, messages } = this.options
    const app = store.app(message.appId)
    const chat = chats.record(message.appId, message.chatId)
    if (!app?.managerId || !app.enabled || !chat?.access) return
    let trigger: FeishuInboxTrigger | null = null
    if (message.mentions.some((mention) => mention.openId === app.botOpenId)) trigger = 'mention'
    else if (message.parentId) {
      const parent = messages.get(message.appId, message.parentId)
      if (!parent) {
        // 回复的那条本地没有：先挂着，回源读到再判
        messages.setTriage(message.appId, message.messageId, 'pending')
        void this.resolve(message)
        return
      }
      if (parent.senderType === 'app' && parent.senderId === message.appId) trigger = 'reply'
    }
    if (!trigger) return
    const bound = chat.access.wakeBound ? this.bound(message.appId, message.senderId) : null
    const listed = chat.access.wakers.some((waker) => waker.openId === message.senderId)
    if (!listed && !bound) return
    this.enqueue(message, app.managerId, trigger, bound)
  }

  private async resolve(message: StoredMessage): Promise<void> {
    const { messages, records, log } = this.options
    try {
      if (message.parentId) await records.fetchMessage(message.appId, message.parentId)
    } catch (error) {
      log(`飞书回复对象回源失败：${(error as Error).message}`)
    }
    const current = messages.get(message.appId, message.messageId)
    if (!current || current.triage !== 'pending') return
    messages.setTriage(message.appId, message.messageId, 'done')
    const parent = message.parentId ? messages.get(message.appId, message.parentId) : null
    // 读不到回复对象就不算找机器人
    if (parent) this.judge(current)
  }

  /** 应用连上时：上次没判完的重新判 */
  recover(appId: string): void {
    for (const message of this.options.messages.pending())
      if (message.appId === appId) void this.resolve(message)
  }

  private enqueue(
    message: StoredMessage,
    managerId: string,
    trigger: FeishuInboxTrigger,
    bound: { name: string } | null,
  ): void {
    const { messages } = this.options
    const member = messages.memberName(message.appId, message.chatId, message.senderId)
    const body: InboxBody = {
      appId: message.appId,
      managerId,
      chatId: message.chatId,
      chatKind: message.chatKind,
      messageId: message.messageId,
      senderOpenId: message.senderId,
      ...(bound?.name || member ? { senderName: bound?.name || member || '' } : {}),
      senderIdentity: bound ? 'bound' : member ? 'member' : 'unknown',
      trigger,
      createdAt: Math.floor(message.createTime / 1000),
      receivedAt: this.options.now(),
    }
    const result = this.db
      .prepare(
        `INSERT INTO feishu_inbox(app_id, message_id, manager_id, status, body)
         VALUES(?,?,?,'queued',?) ON CONFLICT(app_id, message_id) DO NOTHING`,
      )
      .run(message.appId, message.messageId, managerId, JSON.stringify(body))
    if (Number(result.changes) === 0) return
    messages.pin(message.appId, message.messageId)
    this.options.changed(managerId, message.appId)
    for (const hook of this.queuedHooks) hook(managerId)
  }

  // —— 上下文游标 ——

  cursor(managerId: string, appId: string, chatId: string): number {
    const row = this.db
      .prepare(
        'SELECT last_seq FROM feishu_context_cursor WHERE manager_id=? AND app_id=? AND chat_id=?',
      )
      .get(managerId, appId, chatId)
    return row ? Number(row.last_seq) : 0
  }

  advance(managerId: string, appId: string, chatId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO feishu_context_cursor VALUES(?,?,?,?)
         ON CONFLICT(manager_id, app_id, chat_id)
         DO UPDATE SET last_seq=max(last_seq, excluded.last_seq)`,
      )
      .run(managerId, appId, chatId, seq)
  }

  /** 投递没送出时把游标退回原值 */
  resetCursor(managerId: string, appId: string, chatId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO feishu_context_cursor VALUES(?,?,?,?)
         ON CONFLICT(manager_id, app_id, chat_id) DO UPDATE SET last_seq=excluded.last_seq`,
      )
      .run(managerId, appId, chatId, seq)
  }
}
