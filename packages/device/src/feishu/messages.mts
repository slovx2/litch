// 外部 IM 的消息库（<状态目录>/im-messages.sqlite）：消息正文、附件元信息、成员表、补历史水位。
// 量大、写得勤、正文敏感，所以和经理库分开，单独清理。库和 WAL 只有属主可读写。
// 消息时间用平台给的毫秒；本地入库顺序是 seq。
import { closeSync, existsSync, lstatSync, openSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { assertStoreFormat, initializeStoreFormat } from '../../../shared/src/store-format.mjs'
import { ensureParent } from '../../../shared/src/util.mjs'
import type { AttachmentKind, ParsedAttachment } from './content.mjs'

export const IM_MESSAGES_FILE = 'im-messages.sqlite'

const MIGRATIONS = [
  `CREATE TABLE im_messages(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL, chat_kind TEXT NOT NULL,
    root_id TEXT, parent_id TEXT, thread_id TEXT,
    sender_id TEXT NOT NULL, sender_id_type TEXT NOT NULL, sender_type TEXT NOT NULL,
    msg_type TEXT NOT NULL, text TEXT, content TEXT, mentions TEXT NOT NULL,
    create_time INTEGER NOT NULL, update_time INTEGER NOT NULL,
    state TEXT NOT NULL, source TEXT NOT NULL, triage TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, body_purged_at INTEGER,
    UNIQUE(provider, app_id, message_id)
  );
  CREATE INDEX im_messages_chat ON im_messages(provider, app_id, chat_id, create_time);
  CREATE INDEX im_messages_pending ON im_messages(triage) WHERE triage='pending';
  CREATE TABLE im_attachments(
    provider TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL, file_key TEXT NOT NULL,
    body TEXT NOT NULL, PRIMARY KEY(provider, app_id, message_id, file_key)
  );
  CREATE TABLE im_members(
    provider TEXT NOT NULL, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, open_id TEXT NOT NULL,
    name TEXT NOT NULL, present INTEGER NOT NULL, synced_at INTEGER NOT NULL,
    PRIMARY KEY(provider, app_id, chat_id, open_id)
  );
  CREATE TABLE im_chat_sync(
    provider TEXT NOT NULL, app_id TEXT NOT NULL, chat_id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(provider, app_id, chat_id)
  );`,
]

export const IM_MESSAGES_SCHEMA_VERSION = MIGRATIONS.length

function assertPrivate(path: string): void {
  if (process.platform === 'win32') return
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) continue
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error('消息库或 WAL 文件不是仅当前用户可访问的普通文件')
  }
}

export function openImMessages(stateDir: string): DatabaseSync {
  const path = join(stateDir, IM_MESSAGES_FILE)
  ensureParent(path)
  assertPrivate(path)
  if (existsSync(path) && statSync(path).size > 0) assertStoreFormat(path)
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600))
  const db = new DatabaseSync(path)
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > IM_MESSAGES_SCHEMA_VERSION)
      throw new Error(`消息库版本 ${version} 高于支持的 ${IM_MESSAGES_SCHEMA_VERSION}，拒绝打开`)
    if (version === 0) initializeStoreFormat(db)
    db.exec('PRAGMA journal_mode=WAL')
    assertPrivate(path)
    for (let step = version; step < IM_MESSAGES_SCHEMA_VERSION; step++) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(MIGRATIONS[step] as string)
        db.exec(`PRAGMA user_version=${step + 1}`)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export type MessageState = 'normal' | 'recalled' | 'deleted'
/** event 实时收到；backfill 接入或手动补；gap 补缺口；sent 自己发出；fetch 按需回源 */
export type MessageSource = 'event' | 'backfill' | 'gap' | 'sent' | 'fetch'

export interface StoredMention {
  key: string
  openId: string
  name: string
}

export interface StoredMessage {
  seq: number
  appId: string
  messageId: string
  chatId: string
  chatKind: 'group' | 'p2p'
  rootId?: string
  parentId?: string
  threadId?: string
  senderId: string
  senderIdType: 'open_id' | 'app_id'
  senderType: 'user' | 'app'
  msgType: string
  text: string | null
  content: string | null
  mentions: StoredMention[]
  createTime: number
  updateTime: number
  state: MessageState
  source: MessageSource
  triage: 'pending' | 'done'
  pinned: boolean
  bodyPurgedAt?: number
}

export type NewMessage = Omit<StoredMessage, 'seq' | 'pinned' | 'bodyPurgedAt'>

export interface StoredAttachment extends ParsedAttachment {
  messageId: string
  size?: number
  contentType?: string
  downloadedPath?: string
  downloadedAt?: number
}

export interface BackfillState {
  kind: 'access' | 'manual'
  state: 'running' | 'done' | 'failed'
  /** 窗口，秒 */
  start: number
  end: number
  fetched: number
  /** 窗口里超过上限，只留了最新的那些 */
  truncated: boolean
  error?: string
  startedAt: number
  finishedAt?: number
}

export interface GapState {
  at: number
  start: number
  end: number
  fetched: number
  complete: boolean
}

export interface ChatSync {
  /** 实时收到或补缺口补到的最新消息创建时间（毫秒） */
  liveWatermark?: number
  /** 这个群的记录保留几天；取消接入但留着记录时照这个继续清理 */
  retentionDays: number
  backfill?: BackfillState
  gap?: GapState
  membersSyncedAt?: number
}

export type { AttachmentKind }

type Row = Record<string, unknown>
const opt = (value: unknown): string | undefined =>
  value === null || value === undefined ? undefined : String(value)

function messageOf(row: Row): StoredMessage {
  const rootId = opt(row.root_id)
  const parentId = opt(row.parent_id)
  const threadId = opt(row.thread_id)
  const purged = row.body_purged_at === null ? undefined : Number(row.body_purged_at)
  return {
    seq: Number(row.seq),
    appId: String(row.app_id),
    messageId: String(row.message_id),
    chatId: String(row.chat_id),
    chatKind: row.chat_kind === 'p2p' ? 'p2p' : 'group',
    ...(rootId ? { rootId } : {}),
    ...(parentId ? { parentId } : {}),
    ...(threadId ? { threadId } : {}),
    senderId: String(row.sender_id),
    senderIdType: row.sender_id_type === 'app_id' ? 'app_id' : 'open_id',
    senderType: row.sender_type === 'app' ? 'app' : 'user',
    msgType: String(row.msg_type),
    text: opt(row.text) ?? null,
    content: opt(row.content) ?? null,
    mentions: JSON.parse(String(row.mentions)) as StoredMention[],
    createTime: Number(row.create_time),
    updateTime: Number(row.update_time),
    state: String(row.state) as MessageState,
    source: String(row.source) as MessageSource,
    triage: row.triage === 'pending' ? 'pending' : 'done',
    pinned: Number(row.pinned) === 1,
    ...(purged === undefined ? {} : { bodyPurgedAt: purged }),
  }
}

/** 消息库的存取。只在设备进程里用，所有写都是同步的，事件处理函数返回前就落了盘 */
export class ImMessages {
  readonly db: DatabaseSync
  readonly provider: string
  constructor(db: DatabaseSync, provider = 'feishu') {
    this.db = db
    this.provider = provider
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(appId: string, messageId: string): StoredMessage | null {
    const row = this.db
      .prepare('SELECT * FROM im_messages WHERE provider=? AND app_id=? AND message_id=?')
      .get(this.provider, appId, messageId)
    return row ? messageOf(row) : null
  }

  /** 按消息 ID 插入；已有就不动，返回已有的那行 */
  insert(
    message: NewMessage,
    attachments: ParsedAttachment[],
  ): { message: StoredMessage; inserted: boolean } {
    return this.transaction(() => {
      const existing = this.get(message.appId, message.messageId)
      if (existing) return { message: existing, inserted: false }
      this.db
        .prepare(
          `INSERT INTO im_messages(provider, app_id, message_id, chat_id, chat_kind, root_id,
            parent_id, thread_id, sender_id, sender_id_type, sender_type, msg_type, text, content,
            mentions, create_time, update_time, state, source, triage)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          this.provider,
          message.appId,
          message.messageId,
          message.chatId,
          message.chatKind,
          message.rootId ?? null,
          message.parentId ?? null,
          message.threadId ?? null,
          message.senderId,
          message.senderIdType,
          message.senderType,
          message.msgType,
          message.text,
          message.content,
          JSON.stringify(message.mentions),
          message.createTime,
          message.updateTime,
          message.state,
          message.source,
          message.triage,
        )
      this.saveAttachments(message.appId, message.messageId, attachments)
      return {
        message: this.get(message.appId, message.messageId) as StoredMessage,
        inserted: true,
      }
    })
  }

  private saveAttachments(appId: string, messageId: string, attachments: ParsedAttachment[]): void {
    const statement = this.db.prepare(
      `INSERT INTO im_attachments VALUES(?,?,?,?,?)
       ON CONFLICT(provider, app_id, message_id, file_key) DO NOTHING`,
    )
    for (const attachment of attachments)
      statement.run(this.provider, appId, messageId, attachment.fileKey, JSON.stringify(attachment))
  }

  attachments(appId: string, messageId: string): StoredAttachment[] {
    return this.db
      .prepare('SELECT body FROM im_attachments WHERE provider=? AND app_id=? AND message_id=?')
      .all(this.provider, appId, messageId)
      .map((row) => ({ ...(JSON.parse(String(row.body)) as ParsedAttachment), messageId }))
  }

  /** 平台上的新版本盖掉本地正文（编辑以平台最新版为准；回源展开合并转发、卡片也走这里） */
  rewrite(
    appId: string,
    messageId: string,
    patch: {
      text: string
      content?: string | null
      updateTime?: number
      mentions?: StoredMention[]
    },
    attachments: ParsedAttachment[] = [],
  ): void {
    this.transaction(() => {
      const current = this.get(appId, messageId)
      if (!current || current.state !== 'normal' || current.bodyPurgedAt !== undefined) return
      this.db
        .prepare(
          `UPDATE im_messages SET text=?, content=?, update_time=?, mentions=?
           WHERE provider=? AND app_id=? AND message_id=?`,
        )
        .run(
          patch.text,
          patch.content === undefined ? current.content : patch.content,
          patch.updateTime ?? current.updateTime,
          JSON.stringify(patch.mentions ?? current.mentions),
          this.provider,
          appId,
          messageId,
        )
      this.saveAttachments(appId, messageId, attachments)
    })
  }

  /** 撤回：正文清空，文字换成占位；返回已下载附件的本地路径，由调用方删文件 */
  recall(appId: string, messageId: string): string[] | null {
    return this.transaction(() => {
      const current = this.get(appId, messageId)
      if (!current || current.state === 'recalled') return null
      this.db
        .prepare(
          `UPDATE im_messages SET state='recalled', text='[已撤回]', content=NULL
           WHERE provider=? AND app_id=? AND message_id=?`,
        )
        .run(this.provider, appId, messageId)
      return this.dropAttachments(appId, [messageId])
    })
  }

  private dropAttachments(appId: string, messageIds: string[]): string[] {
    const paths: string[] = []
    const select = this.db.prepare(
      'SELECT body FROM im_attachments WHERE provider=? AND app_id=? AND message_id=?',
    )
    const remove = this.db.prepare(
      'DELETE FROM im_attachments WHERE provider=? AND app_id=? AND message_id=?',
    )
    for (const messageId of messageIds) {
      for (const row of select.all(this.provider, appId, messageId)) {
        const path = (JSON.parse(String(row.body)) as StoredAttachment).downloadedPath
        if (path) paths.push(path)
      }
      remove.run(this.provider, appId, messageId)
    }
    return paths
  }

  // —— 分拣（收件箱用） ——

  pending(): StoredMessage[] {
    return this.db
      .prepare("SELECT * FROM im_messages WHERE provider=? AND triage='pending' ORDER BY seq")
      .all(this.provider)
      .map(messageOf)
  }

  settle(appId: string, messageId: string): void {
    this.db
      .prepare(
        "UPDATE im_messages SET triage='done' WHERE provider=? AND app_id=? AND message_id=?",
      )
      .run(this.provider, appId, messageId)
  }

  /** 被收件箱或看板引用的消息过期时只清正文 */
  pin(appId: string, messageId: string): boolean {
    const result = this.db
      .prepare('UPDATE im_messages SET pinned=1 WHERE provider=? AND app_id=? AND message_id=?')
      .run(this.provider, appId, messageId)
    return Number(result.changes) > 0
  }

  /** 一个群里 seq 在 afterSeq 之后、创建时间不早于 minCreateTime 的消息，按 seq 升序，留最新的 limit 条 */
  since(
    appId: string,
    chatId: string,
    afterSeq: number,
    minCreateTime: number,
    limit: number,
  ): { messages: StoredMessage[]; total: number } {
    const where = `provider=? AND app_id=? AND chat_id=? AND seq>? AND create_time>=?`
    const args = [this.provider, appId, chatId, afterSeq, minCreateTime] as const
    const total = Number(
      this.db.prepare(`SELECT count(*) AS n FROM im_messages WHERE ${where}`).get(...args)?.n ?? 0,
    )
    const messages = this.db
      .prepare(`SELECT * FROM im_messages WHERE ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...args, limit)
      .map(messageOf)
      .reverse()
    return { messages, total }
  }

  /** 查历史：按时间、关键字、消息 ID 筛，按创建时间升序，留最新的 limit 条 */
  search(
    appId: string,
    chatId: string,
    filter: { since?: number; until?: number; keyword?: string; messageIds?: string[] },
    limit: number,
  ): StoredMessage[] {
    const clauses = ['provider=?', 'app_id=?', 'chat_id=?']
    const args: (string | number)[] = [this.provider, appId, chatId]
    if (filter.since !== undefined) {
      clauses.push('create_time>=?')
      args.push(filter.since)
    }
    if (filter.until !== undefined) {
      clauses.push('create_time<=?')
      args.push(filter.until)
    }
    if (filter.keyword) {
      clauses.push("instr(lower(coalesce(text,'')), lower(?))>0")
      args.push(filter.keyword)
    }
    if (filter.messageIds?.length) {
      clauses.push(`message_id IN (${filter.messageIds.map(() => '?').join(',')})`)
      args.push(...filter.messageIds)
    }
    return this.db
      .prepare(
        `SELECT * FROM im_messages WHERE ${clauses.join(' AND ')}
         ORDER BY create_time DESC, seq DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map(messageOf)
      .reverse()
  }

  /** 附件下载后记下本地路径 */
  saveDownload(appId: string, messageId: string, attachment: StoredAttachment): void {
    const { messageId: _drop, ...body } = attachment
    this.db
      .prepare(
        'UPDATE im_attachments SET body=? WHERE provider=? AND app_id=? AND message_id=? AND file_key=?',
      )
      .run(JSON.stringify(body), this.provider, appId, messageId, attachment.fileKey)
  }

  setTriage(appId: string, messageId: string, triage: 'pending' | 'done'): void {
    this.db
      .prepare('UPDATE im_messages SET triage=? WHERE provider=? AND app_id=? AND message_id=?')
      .run(triage, this.provider, appId, messageId)
  }

  // —— 统计与水位 ——

  count(appId: string, chatId: string): { messages: number; oldestAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n, min(create_time) AS oldest FROM im_messages
         WHERE provider=? AND app_id=? AND chat_id=? AND body_purged_at IS NULL`,
      )
      .get(this.provider, appId, chatId)
    return {
      messages: Number(row?.n ?? 0),
      oldestAt: row?.oldest === null || row?.oldest === undefined ? null : Number(row.oldest),
    }
  }

  sync(appId: string, chatId: string): ChatSync | null {
    const row = this.db
      .prepare('SELECT body FROM im_chat_sync WHERE provider=? AND app_id=? AND chat_id=?')
      .get(this.provider, appId, chatId)
    return row ? (JSON.parse(String(row.body)) as ChatSync) : null
  }

  saveSync(appId: string, chatId: string, sync: ChatSync): void {
    this.db
      .prepare(
        `INSERT INTO im_chat_sync VALUES(?,?,?,?)
         ON CONFLICT(provider, app_id, chat_id) DO UPDATE SET body=excluded.body`,
      )
      .run(this.provider, appId, chatId, JSON.stringify(sync))
  }

  /** 改一行水位；没有就按给的保留天数建一行 */
  patchSync(
    appId: string,
    chatId: string,
    retentionDays: number,
    patch: (sync: ChatSync) => ChatSync,
  ): ChatSync {
    const next = patch(this.sync(appId, chatId) ?? { retentionDays })
    this.saveSync(appId, chatId, next)
    return next
  }

  syncedChats(): { appId: string; chatId: string; sync: ChatSync }[] {
    return this.db
      .prepare('SELECT app_id, chat_id, body FROM im_chat_sync WHERE provider=?')
      .all(this.provider)
      .map((row) => ({
        appId: String(row.app_id),
        chatId: String(row.chat_id),
        sync: JSON.parse(String(row.body)) as ChatSync,
      }))
  }

  // —— 成员表 ——

  saveMembers(
    appId: string,
    chatId: string,
    members: { openId: string; name: string }[],
    at: number,
    complete: boolean,
  ): void {
    this.transaction(() => {
      // 整表回源时，不在名单里的人标成已不在群里
      if (complete)
        this.db
          .prepare('UPDATE im_members SET present=0 WHERE provider=? AND app_id=? AND chat_id=?')
          .run(this.provider, appId, chatId)
      const statement = this.db.prepare(
        `INSERT INTO im_members VALUES(?,?,?,?,?,1,?)
         ON CONFLICT(provider, app_id, chat_id, open_id)
         DO UPDATE SET name=excluded.name, present=1, synced_at=excluded.synced_at`,
      )
      for (const member of members)
        statement.run(this.provider, appId, chatId, member.openId, member.name, at)
    })
  }

  membersLeft(appId: string, chatId: string, openIds: string[], at: number): void {
    const statement = this.db.prepare(
      `UPDATE im_members SET present=0, synced_at=?
       WHERE provider=? AND app_id=? AND chat_id=? AND open_id=?`,
    )
    for (const openId of openIds) statement.run(at, this.provider, appId, chatId, openId)
  }

  members(appId: string, chatId: string): { openId: string; name: string; present: boolean }[] {
    return this.db
      .prepare(
        `SELECT open_id, name, present FROM im_members
         WHERE provider=? AND app_id=? AND chat_id=? ORDER BY name`,
      )
      .all(this.provider, appId, chatId)
      .map((row) => ({
        openId: String(row.open_id),
        name: String(row.name),
        present: Number(row.present) === 1,
      }))
  }

  memberName(appId: string, chatId: string, openId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT name FROM im_members WHERE provider=? AND app_id=? AND chat_id=? AND open_id=?',
      )
      .get(this.provider, appId, chatId, openId)
    return row ? String(row.name) : null
  }

  /** 任一已接入群成员表里这个人的名字（私聊配对时显示用） */
  personName(appId: string, openId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT name FROM im_members WHERE provider=? AND app_id=? AND open_id=? ORDER BY synced_at DESC LIMIT 1',
      )
      .get(this.provider, appId, openId)
    return row ? String(row.name) : null
  }

  // —— 删除与清理 ——

  /**
   * 删掉一个群早于 cutoff（毫秒，缺省为全部）的消息。被引用的只清正文、留 ID 和元信息。
   * 返回已下载附件的本地路径，由调用方删文件。
   */
  purge(appId: string, chatId: string, now: number, cutoff?: number): string[] {
    return this.transaction(() => {
      const before = cutoff ?? Number.MAX_SAFE_INTEGER
      const ids = this.db
        .prepare(
          `SELECT message_id FROM im_messages
           WHERE provider=? AND app_id=? AND chat_id=? AND create_time<?
             AND (pinned=0 OR body_purged_at IS NULL)`,
        )
        .all(this.provider, appId, chatId, before)
        .map((row) => String(row.message_id))
      const paths = this.dropAttachments(appId, ids)
      this.db
        .prepare(
          `UPDATE im_messages SET text=NULL, content=NULL, mentions='[]', body_purged_at=?
           WHERE provider=? AND app_id=? AND chat_id=? AND create_time<? AND pinned=1
             AND body_purged_at IS NULL`,
        )
        .run(now, this.provider, appId, chatId, before)
      this.db
        .prepare(
          `DELETE FROM im_messages
           WHERE provider=? AND app_id=? AND chat_id=? AND create_time<? AND pinned=0`,
        )
        .run(this.provider, appId, chatId, before)
      return paths
    })
  }

  /** 取消接入并删记录：消息照 purge，成员表和水位一起删 */
  forgetChat(appId: string, chatId: string, now: number): string[] {
    const paths = this.purge(appId, chatId, now)
    this.transaction(() => {
      for (const table of ['im_members', 'im_chat_sync'])
        this.db
          .prepare(`DELETE FROM ${table} WHERE provider=? AND app_id=? AND chat_id=?`)
          .run(this.provider, appId, chatId)
    })
    return paths
  }
}
