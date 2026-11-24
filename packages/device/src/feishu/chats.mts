// 机器人所在的群与接入设置（D-150、D-160、D-162、D-172、D-178）。
// 群列表在连上时回源同步，进退群、改名、解散事件随时更新；没接入的群只有列表信息。
// 接入后才收、记、发：发言模式记在通用发言权限里（speech_policies），其余设置在群行的 body 里。
// 系统同步改的字段（名字、头像、在不在群、解散）不升 revision，免得和用户正在做的修改冲突。
import {
  FEISHU_NOTIFICATION,
  type FeishuChat,
  type FeishuChatAccess,
  type FeishuChatAccessParams,
  type FeishuChatRecords,
  type FeishuChatUpdateParams,
  type FeishuMember,
  type FeishuPerson,
} from '../../../protocol/src/feishu.mjs'
import type { FeishuApi } from './api.mjs'
import type { SpeechPolicies } from './speech-policy.mjs'
import type { FeishuStore } from './store.mjs'

export const FEISHU_CHATS_MIGRATION = `
CREATE TABLE feishu_chats(
  app_id TEXT NOT NULL, chat_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(app_id, chat_id)
);
`

export const FEISHU_SPEECH_PROVIDER = 'feishu'
/** 成员表缓存多久（秒）；选择器打开时可以要求回源 */
const MEMBERS_TTL = 300
const PAGE_LIMIT = 100

type AccessRecord = Omit<FeishuChatAccess, 'speech'>
export type FeishuChatRecord = Omit<FeishuChat, 'access'> & { access: AccessRecord | null }

export interface FeishuChatsOptions {
  store: FeishuStore
  policies: SpeechPolicies
  api: (appId: string) => FeishuApi | null
  now: () => number
  announce: (method: string, params: unknown) => void
  fail: (reason: string) => never
  log: (message: string) => void
}

const text = (value: unknown, max = 256): string =>
  typeof value === 'string' ? value.slice(0, max) : ''
const https = (value: unknown): string | undefined =>
  typeof value === 'string' && /^https:\/\//.test(value) ? value.slice(0, 2048) : undefined
const scopeOf = (appId: string, chatId: string) => `${appId}/${chatId}`

export class FeishuChats {
  private readonly options: FeishuChatsOptions
  private readonly syncedAt = new Map<string, number>()
  private readonly syncing = new Map<string, Promise<void>>()
  private readonly members = new Map<string, { members: FeishuMember[]; fetchedAt: number }>()
  /** 取消接入时要做的事（删记录等） */
  private readonly unaccessHooks: ((
    appId: string,
    chatId: string,
    deleteRecords: boolean,
  ) => void)[] = []
  /** 接入或改了接入设置之后要做的事；first 表示这次是新接入 */
  private readonly accessHooks: ((chat: FeishuChatRecord, first: boolean) => void)[] = []
  /** 群在设备上的记录（消息库给出），拼进视图 */
  recordsOf: (appId: string, chatId: string) => FeishuChatRecords | undefined = () => undefined

  constructor(options: FeishuChatsOptions) {
    this.options = options
  }

  onUnaccess(hook: (appId: string, chatId: string, deleteRecords: boolean) => void): void {
    this.unaccessHooks.push(hook)
  }

  onAccess(hook: (chat: FeishuChatRecord, first: boolean) => void): void {
    this.accessHooks.push(hook)
  }

  private runHooks(work: () => void): void {
    try {
      work()
    } catch (error) {
      this.options.log(`飞书群设置变化后的处理出错：${(error as Error).message}`)
    }
  }

  /** 成员变了（进退群事件）：下次选择器打开时重新回源 */
  forgetMembers(appId: string, chatId: string): void {
    this.members.delete(scopeOf(appId, chatId))
  }

  /** 已接入、机器人还在群里、没解散的群 */
  activeChats(appId: string): FeishuChatRecord[] {
    return this.records(appId).filter(
      (chat) => chat.access && chat.botPresent && chat.status === 'normal',
    )
  }

  private get db() {
    return this.options.store.managers.db
  }

  private fail(reason: string): never {
    return this.options.fail(reason)
  }

  // —— 存取 ——

  record(appId: string, chatId: string): FeishuChatRecord | null {
    const row = this.db
      .prepare('SELECT body FROM feishu_chats WHERE app_id=? AND chat_id=?')
      .get(appId, chatId)
    return row ? (JSON.parse(String(row.body)) as FeishuChatRecord) : null
  }

  private records(appId: string): FeishuChatRecord[] {
    return this.db
      .prepare('SELECT body FROM feishu_chats WHERE app_id=? ORDER BY rowid')
      .all(appId)
      .map((row) => JSON.parse(String(row.body)) as FeishuChatRecord)
  }

  private save(chat: FeishuChatRecord): void {
    this.db
      .prepare(
        `INSERT INTO feishu_chats VALUES(?,?,?)
         ON CONFLICT(app_id, chat_id) DO UPDATE SET body=excluded.body`,
      )
      .run(chat.appId, chat.chatId, JSON.stringify(chat))
  }

  private delete(appId: string, chatId: string): void {
    this.db.prepare('DELETE FROM feishu_chats WHERE app_id=? AND chat_id=?').run(appId, chatId)
  }

  /** 移除应用时一并清掉它的群和发言模式 */
  removeApp(appId: string): void {
    this.db.prepare('DELETE FROM feishu_chats WHERE app_id=?').run(appId)
    this.options.policies.removePrefix(FEISHU_SPEECH_PROVIDER, `${appId}/`)
    this.syncedAt.delete(appId)
    for (const key of [...this.members.keys()])
      if (key.startsWith(`${appId}/`)) this.members.delete(key)
  }

  view(chat: FeishuChatRecord): FeishuChat {
    const stored = this.recordsOf(chat.appId, chat.chatId)
    const records = stored ? { records: stored } : {}
    if (!chat.access) return { ...chat, access: null, ...records }
    const policy = this.options.policies.get(
      FEISHU_SPEECH_PROVIDER,
      scopeOf(chat.appId, chat.chatId),
    )
    return { ...chat, access: { ...chat.access, speech: policy?.mode ?? 'approval' }, ...records }
  }

  private changed(appId: string, chatId?: string): void {
    this.options.announce(FEISHU_NOTIFICATION.chatsChanged, chatId ? { appId, chatId } : { appId })
  }

  /** 已接入、机器人在群里、群没解散：这时才收、记、发 */
  active(appId: string, chatId: string): boolean {
    const chat = this.record(appId, chatId)
    return Boolean(chat?.access && chat.botPresent && chat.status === 'normal')
  }

  // —— 同步 ——

  /** 回源列机器人所在的全部群；同一应用同时只跑一次 */
  sync(appId: string): Promise<void> {
    const running = this.syncing.get(appId)
    if (running) return running
    const work = this.syncOnce(appId).finally(() => this.syncing.delete(appId))
    this.syncing.set(appId, work)
    return work
  }

  private async syncOnce(appId: string): Promise<void> {
    const api = this.options.api(appId) ?? this.fail('feishu_app_inactive')
    const seen = new Map<string, Record<string, unknown>>()
    let pageToken = ''
    for (let page = 0; page < PAGE_LIMIT; page += 1) {
      const query: Record<string, string> = { page_size: '100' }
      if (pageToken) query.page_token = pageToken
      const data = await api.data('GET', '/open-apis/im/v1/chats', { query })
      for (const item of Array.isArray(data.items) ? data.items : []) {
        const chatId = text((item as Record<string, unknown>).chat_id, 128)
        if (/^oc_/.test(chatId)) seen.set(chatId, item as Record<string, unknown>)
      }
      pageToken = data.has_more === true ? text(data.page_token, 512) : ''
      if (!pageToken) break
    }
    const now = this.options.now()
    this.options.store.transaction(() => {
      for (const [chatId, item] of seen) {
        const current = this.record(appId, chatId)
        const status = item.chat_status === 'dissolved' ? 'dissolved' : 'normal'
        const avatar = https(item.avatar)
        const next: FeishuChatRecord = {
          appId,
          chatId,
          revision: current?.revision ?? 1,
          name: text(item.name) || current?.name || chatId,
          ...(avatar ? { avatar } : {}),
          external: item.external === true,
          status,
          botPresent: true,
          access: current?.access ?? null,
          updatedAt: current?.updatedAt ?? now,
        }
        if (JSON.stringify(current) !== JSON.stringify(next)) this.save({ ...next, updatedAt: now })
      }
      for (const chat of this.records(appId)) {
        if (seen.has(chat.chatId)) continue
        // 不在列表里：没接入的直接忘掉；接入过的保留设置，标机器人已不在群里（D-178）
        if (!chat.access) this.delete(appId, chat.chatId)
        else if (chat.botPresent) this.save({ ...chat, botPresent: false, updatedAt: now })
      }
    })
    this.syncedAt.set(appId, now)
    this.changed(appId)
  }

  async list(
    appId: string,
    refresh: boolean,
  ): Promise<{ chats: FeishuChat[]; syncedAt: number | null }> {
    if (refresh) {
      try {
        await this.sync(appId)
      } catch (error) {
        if ((error as Error).message === 'feishu_app_inactive') throw error
        this.fail('feishu_sync_failed')
      }
    }
    return {
      chats: this.records(appId).map((chat) => this.view(chat)),
      syncedAt: this.syncedAt.get(appId) ?? null,
    }
  }

  get(appId: string, chatId: string): FeishuChat {
    return this.view(this.record(appId, chatId) ?? this.fail('feishu_chat_not_found'))
  }

  async memberList(
    appId: string,
    chatId: string,
    refresh: boolean,
  ): Promise<{ members: FeishuMember[]; fetchedAt: number }> {
    const chat = this.record(appId, chatId) ?? this.fail('feishu_chat_not_found')
    if (!chat.botPresent || chat.status !== 'normal') this.fail('feishu_chat_unavailable')
    const key = scopeOf(appId, chatId)
    const cached = this.members.get(key)
    const now = this.options.now()
    if (cached && !refresh && now - cached.fetchedAt < MEMBERS_TTL) return cached
    const api = this.options.api(appId) ?? this.fail('feishu_app_inactive')
    const members: FeishuMember[] = []
    let pageToken = ''
    try {
      for (let page = 0; page < PAGE_LIMIT; page += 1) {
        const query: Record<string, string> = { member_id_type: 'open_id', page_size: '100' }
        if (pageToken) query.page_token = pageToken
        const data = await api.data(
          'GET',
          `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`,
          {
            query,
          },
        )
        for (const raw of Array.isArray(data.items) ? data.items : []) {
          const item = raw as Record<string, unknown>
          const openId = text(item.member_id, 128)
          if (/^ou_/.test(openId)) members.push({ openId, name: text(item.name) || openId })
        }
        pageToken = data.has_more === true ? text(data.page_token, 512) : ''
        if (!pageToken) break
      }
    } catch {
      return this.fail('feishu_members_failed')
    }
    const result = { members, fetchedAt: now }
    this.members.set(key, result)
    return result
  }

  /** 叫醒名单里的人必须是当前群成员；已经在名单里的保留原来的名字快照 */
  private async wakers(
    appId: string,
    chatId: string,
    openIds: string[],
    previous: FeishuPerson[],
  ): Promise<FeishuPerson[]> {
    const known = new Map(previous.map((person) => [person.openId, person]))
    if (openIds.every((openId) => known.has(openId)))
      return openIds.map((openId) => known.get(openId) as FeishuPerson)
    let roster = await this.memberList(appId, chatId, false)
    if (
      openIds.some(
        (openId) => !known.has(openId) && !roster.members.some((m) => m.openId === openId),
      )
    )
      roster = await this.memberList(appId, chatId, true)
    const names = new Map(roster.members.map((member) => [member.openId, member]))
    return openIds.map((openId) => {
      const person = known.get(openId) ?? names.get(openId)
      return person ? { openId, name: person.name } : this.fail('feishu_waker_not_member')
    })
  }

  // —— 接入设置（只给管理员连接） ——

  async access(params: FeishuChatAccessParams): Promise<FeishuChat> {
    const { appId, chatId } = params
    const before = this.record(appId, chatId) ?? this.fail('feishu_chat_not_found')
    if (before.access) this.fail('feishu_chat_accessed')
    if (!before.botPresent || before.status !== 'normal') this.fail('feishu_chat_unavailable')
    if (before.revision !== params.expectedRevision) this.fail('feishu_revision_conflict')
    // 外部群要二次确认（D-172）
    if (before.external && params.confirmExternal !== true) this.fail('feishu_external_unconfirmed')
    const wakers = await this.wakers(appId, chatId, params.wakers, [])
    const now = this.options.now()
    const next = this.options.store.transaction(() => {
      const chat = this.record(appId, chatId) ?? this.fail('feishu_chat_not_found')
      if (chat.access) this.fail('feishu_chat_accessed')
      if (chat.revision !== params.expectedRevision) this.fail('feishu_revision_conflict')
      const updated: FeishuChatRecord = {
        ...chat,
        revision: chat.revision + 1,
        access: {
          wakeBound: params.wakeBound,
          wakers,
          retentionDays: params.retentionDays,
          reviewTtlHours: params.reviewTtlHours,
          accessAt: now,
        },
        updatedAt: now,
      }
      this.save(updated)
      this.options.policies.set(FEISHU_SPEECH_PROVIDER, scopeOf(appId, chatId), {
        mode: params.speech,
        updatedAt: now,
      })
      this.options.store.audit(appId, now, {
        action: 'chat_accessed',
        by: 'admin',
        detail: { chatId, speech: params.speech, external: chat.external, wakers: wakers.length },
      })
      return updated
    })
    for (const hook of this.accessHooks) this.runHooks(() => hook(next, true))
    this.changed(appId, chatId)
    return this.view(next)
  }

  async update(params: FeishuChatUpdateParams): Promise<FeishuChat> {
    const { appId, chatId } = params
    const before = this.record(appId, chatId) ?? this.fail('feishu_chat_not_found')
    if (!before.access) this.fail('feishu_chat_not_accessed')
    if (before.revision !== params.expectedRevision) this.fail('feishu_revision_conflict')
    const wakers = params.wakers
      ? await this.wakers(appId, chatId, params.wakers, before.access.wakers)
      : undefined
    const now = this.options.now()
    const next = this.options.store.transaction(() => {
      const chat = this.record(appId, chatId) ?? this.fail('feishu_chat_not_found')
      if (!chat.access) this.fail('feishu_chat_not_accessed')
      if (chat.revision !== params.expectedRevision) this.fail('feishu_revision_conflict')
      const access: AccessRecord = {
        ...chat.access,
        ...(params.wakeBound === undefined ? {} : { wakeBound: params.wakeBound }),
        ...(wakers ? { wakers } : {}),
        ...(params.retentionDays === undefined ? {} : { retentionDays: params.retentionDays }),
        ...(params.reviewTtlHours === undefined ? {} : { reviewTtlHours: params.reviewTtlHours }),
      }
      const updated: FeishuChatRecord = {
        ...chat,
        revision: chat.revision + 1,
        access,
        updatedAt: now,
      }
      this.save(updated)
      if (params.speech)
        this.options.policies.set(FEISHU_SPEECH_PROVIDER, scopeOf(appId, chatId), {
          mode: params.speech,
          updatedAt: now,
        })
      this.options.store.audit(appId, now, {
        action: 'chat_updated',
        by: 'admin',
        detail: {
          chatId,
          ...(params.speech ? { speech: params.speech } : {}),
          ...(params.wakeBound === undefined ? {} : { wakeBound: params.wakeBound }),
          ...(wakers ? { wakers: wakers.length } : {}),
          ...(params.retentionDays === undefined ? {} : { retentionDays: params.retentionDays }),
          ...(params.reviewTtlHours === undefined ? {} : { reviewTtlHours: params.reviewTtlHours }),
        },
      })
      return updated
    })
    for (const hook of this.accessHooks) this.runHooks(() => hook(next, false))
    this.changed(appId, chatId)
    return this.view(next)
  }

  unaccess(
    appId: string,
    chatId: string,
    expectedRevision: number,
    deleteRecords: boolean,
  ): FeishuChat {
    const now = this.options.now()
    const next = this.options.store.transaction(() => {
      const chat = this.record(appId, chatId) ?? this.fail('feishu_chat_not_found')
      if (!chat.access) this.fail('feishu_chat_not_accessed')
      if (chat.revision !== expectedRevision) this.fail('feishu_revision_conflict')
      const updated: FeishuChatRecord = {
        ...chat,
        revision: chat.revision + 1,
        access: null,
        updatedAt: now,
      }
      // 机器人已不在群里、群已解散的，取消接入后就没有留着的理由
      if (chat.botPresent && chat.status === 'normal') this.save(updated)
      else this.delete(appId, chatId)
      this.options.policies.remove(FEISHU_SPEECH_PROVIDER, scopeOf(appId, chatId))
      this.options.store.audit(appId, now, {
        action: 'chat_unaccessed',
        by: 'admin',
        detail: { chatId, deleteRecords },
      })
      return updated
    })
    for (const hook of this.unaccessHooks) this.runHooks(() => hook(appId, chatId, deleteRecords))
    this.changed(appId, chatId)
    return this.view(next)
  }

  // —— 事件 ——

  /** 机器人被拉进群：只进列表，不接入；之前接入过的自动恢复（D-178） */
  botAdded(appId: string, data: Record<string, unknown>): void {
    const chatId = text(data.chat_id, 128)
    if (!/^oc_/.test(chatId)) return
    const now = this.options.now()
    const current = this.record(appId, chatId)
    this.save({
      appId,
      chatId,
      revision: current?.revision ?? 1,
      name: text(data.name) || current?.name || chatId,
      ...(current?.avatar ? { avatar: current.avatar } : {}),
      external: data.external === true || (current?.external ?? false),
      status: 'normal',
      botPresent: true,
      access: current?.access ?? null,
      updatedAt: now,
    })
    if (current?.access && !current.botPresent)
      this.options.store.audit(appId, now, {
        action: 'chat_bot_returned',
        by: 'device',
        detail: { chatId },
      })
    this.changed(appId, chatId)
  }

  botDeleted(appId: string, data: Record<string, unknown>): void {
    const chatId = text(data.chat_id, 128)
    const current = this.record(appId, chatId)
    if (!current) return
    const now = this.options.now()
    if (!current.access) this.delete(appId, chatId)
    else {
      this.save({ ...current, botPresent: false, updatedAt: now })
      this.options.store.audit(appId, now, {
        action: 'chat_bot_removed',
        by: 'device',
        detail: { chatId },
      })
    }
    this.changed(appId, chatId)
  }

  chatUpdated(appId: string, data: Record<string, unknown>): void {
    const chatId = text(data.chat_id, 128)
    const current = this.record(appId, chatId)
    if (!current) return
    const after = (data.after_change ?? {}) as Record<string, unknown>
    const name = text(after.name)
    const avatar = https(after.avatar)
    const next = {
      ...current,
      ...(name ? { name } : {}),
      ...(avatar ? { avatar } : {}),
      ...(typeof data.external === 'boolean' ? { external: data.external } : {}),
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return
    this.save({ ...next, updatedAt: this.options.now() })
    this.changed(appId, chatId)
  }

  disbanded(appId: string, data: Record<string, unknown>): void {
    const chatId = text(data.chat_id, 128)
    const current = this.record(appId, chatId)
    if (!current) return
    const now = this.options.now()
    if (!current.access) this.delete(appId, chatId)
    else {
      this.save({ ...current, status: 'dissolved', updatedAt: now })
      this.options.store.audit(appId, now, {
        action: 'chat_disbanded',
        by: 'device',
        detail: { chatId },
      })
    }
    this.changed(appId, chatId)
  }
}
