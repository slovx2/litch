// 私聊绑定（D-158、D-174、D-177）：经理只和已绑定的人私聊。
// - 没绑定的人私聊机器人：设备只回一条配对码（正文不落库）。码 8 位、加密随机、加盐哈希存库、1 小时过期；
//   同一个人一小时内再发不换码、10 分钟内不重复回；一个应用最多 20 个待批配对，超了不回，审计记一次。
// - 设备管理员在 Litch 里输入配对码确认后绑定，设备给对方回一句“已绑定”（系统消息，不走审批）。
// - 已绑定的人可以标成审批人，在飞书里收审批卡片并批；第一个绑定的人默认是审批人。
// 码的明文只在内存里（用来在一小时内重发同一个码）；设备重启后同一个人再发消息就换一个新码。
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import {
  FEISHU_NOTIFICATION,
  FEISHU_PAIRING_ALPHABET,
  FEISHU_RETENTION_DAYS,
  type FeishuBinding,
  type FeishuPairing,
} from '../../../protocol/src/feishu.mjs'
import type { FeishuApi } from './api.mjs'
import type { ImMessages } from './messages.mjs'
import type { FeishuStore } from './store.mjs'

export const FEISHU_BINDINGS_MIGRATION = `
CREATE TABLE feishu_bindings(
  app_id TEXT NOT NULL, open_id TEXT NOT NULL, state TEXT NOT NULL, p2p_chat_id TEXT, body TEXT NOT NULL,
  PRIMARY KEY(app_id, open_id)
);
CREATE INDEX feishu_bindings_chat ON feishu_bindings(app_id, p2p_chat_id);
CREATE TABLE feishu_pairings(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, open_id TEXT NOT NULL, state TEXT NOT NULL,
  expires_at INTEGER NOT NULL, body TEXT NOT NULL
);
CREATE INDEX feishu_pairings_app ON feishu_pairings(app_id, state, expires_at);
CREATE TABLE feishu_review_notices(
  review_id TEXT NOT NULL, open_id TEXT NOT NULL, app_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(review_id, open_id)
);
`

const PAIRING_TTL = 3600
const RESEND_AFTER = 600
const PENDING_MAX = 20

/** 库里的绑定：多存私聊的 chat_id（发私聊、认私聊记录用，不出协议） */
export interface BindingRecord extends FeishuBinding {
  p2pChatId?: string
}

interface PairingRecord {
  appId: string
  openId: string
  unionId?: string
  userId?: string
  name?: string
  chatId: string
  salt: string
  codeHash: string
  createdAt: number
  expiresAt: number
  sentAt: number
  /** 回过几次（拼系统消息的去重标识） */
  sends: number
}

/** 收到的私聊里能认出的发送人信息 */
export interface PairingRequest {
  openId: string
  unionId?: string
  userId?: string
  chatId: string
}

export interface FeishuBindingsOptions {
  store: FeishuStore
  messages: ImMessages
  api: (appId: string) => FeishuApi | null
  /** 秒 */
  now: () => number
  announce: (method: string, params: unknown) => void
  fail: (reason: string) => never
  log: (message: string) => void
}

const hash = (salt: string, code: string) => createHash('sha256').update(`${salt}:${code}`).digest()

/** 用户输入的码：去掉横线空格、转大写 */
export const normalizeCode = (code: string) => code.replace(/[- ]/g, '').toUpperCase()

function newCode(): string {
  let code = ''
  for (let index = 0; index < 8; index++)
    code += FEISHU_PAIRING_ALPHABET[randomInt(FEISHU_PAIRING_ALPHABET.length)]
  return code
}

const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

export const PAIRING_TEXT = (code: string) =>
  `【Litch】请把配对码 ${shown(code)} 告诉 Litch 的使用者，由对方在 Litch 里确认绑定，1 小时内有效。\nTo chat with this bot, give the pairing code ${shown(code)} to the Litch user and ask them to confirm it in Litch. The code expires in 1 hour.`
export const BOUND_TEXT =
  '【Litch】已绑定，之后的私聊消息会交给经理处理。\nYou are now paired. Your direct messages will go to the manager.'

export class FeishuBindings {
  private readonly options: FeishuBindingsOptions
  /** 配对码明文（seq → 码），只在内存里 */
  private readonly codes = new Map<number, string>()
  /** 每个应用上次因配对太多而记审计的时间 */
  private readonly limited = new Map<string, number>()
  /** 后台在发的系统消息（测试等它们发完） */
  private readonly sending = new Set<Promise<void>>()

  constructor(options: FeishuBindingsOptions) {
    this.options = options
  }

  private get db() {
    return this.options.store.managers.db
  }

  // —— 读 ——

  record(appId: string, openId: string): BindingRecord | null {
    const row = this.db
      .prepare('SELECT body FROM feishu_bindings WHERE app_id=? AND open_id=?')
      .get(appId, openId)
    return row ? (JSON.parse(String(row.body)) as BindingRecord) : null
  }

  /** 已绑定（没撤销）的人 */
  bound(appId: string, openId: string): BindingRecord | null {
    const record = this.record(appId, openId)
    return record?.state === 'bound' ? record : null
  }

  /** 私聊的 chat_id 对应的绑定（撤销了的也算，私聊记录按它的保留期清理） */
  byChat(appId: string, chatId: string): BindingRecord | null {
    const row = this.db
      .prepare('SELECT body FROM feishu_bindings WHERE app_id=? AND p2p_chat_id=?')
      .get(appId, chatId)
    return row ? (JSON.parse(String(row.body)) as BindingRecord) : null
  }

  records(appId: string): BindingRecord[] {
    return this.db
      .prepare('SELECT body FROM feishu_bindings WHERE app_id=?')
      .all(appId)
      .map((row) => JSON.parse(String(row.body)) as BindingRecord)
      .sort((a, b) => b.boundAt - a.boundAt)
  }

  list(appId: string): FeishuBinding[] {
    return this.records(appId).map(view)
  }

  /** 能在飞书里批审批的人：已绑定、标了审批人、知道私聊会话 */
  approvers(appId: string): BindingRecord[] {
    return this.records(appId).filter(
      (record) => record.state === 'bound' && record.approver && record.p2pChatId,
    )
  }

  pendingCount(appId: string): number {
    this.expire(appId)
    const row = this.db
      .prepare("SELECT count(*) AS n FROM feishu_pairings WHERE app_id=? AND state='pending'")
      .get(appId)
    return Number(row?.n ?? 0)
  }

  private save(record: BindingRecord): void {
    this.db
      .prepare(
        `INSERT INTO feishu_bindings VALUES(?,?,?,?,?)
         ON CONFLICT(app_id, open_id) DO UPDATE SET state=excluded.state,
           p2p_chat_id=excluded.p2p_chat_id, body=excluded.body`,
      )
      .run(
        record.appId,
        record.openId,
        record.state,
        record.p2pChatId ?? null,
        JSON.stringify(record),
      )
  }

  private changed(appId: string, openId?: string): void {
    this.options.announce(FEISHU_NOTIFICATION.bindingsChanged, {
      appId,
      ...(openId ? { openId } : {}),
    })
    // 应用上的待批配对数跟着变
    this.options.announce(FEISHU_NOTIFICATION.appsChanged, { appId })
  }

  // —— 配对请求 ——

  private expire(appId: string): void {
    this.db
      .prepare(
        "UPDATE feishu_pairings SET state='expired' WHERE app_id=? AND state='pending' AND expires_at<=?",
      )
      .run(appId, this.options.now())
  }

  private pendings(appId: string): { seq: number; record: PairingRecord }[] {
    this.expire(appId)
    return this.db
      .prepare(
        "SELECT seq, body FROM feishu_pairings WHERE app_id=? AND state='pending' ORDER BY seq",
      )
      .all(appId)
      .map((row) => ({
        seq: Number(row.seq),
        record: JSON.parse(String(row.body)) as PairingRecord,
      }))
  }

  private savePairing(seq: number, record: PairingRecord): void {
    this.db
      .prepare('UPDATE feishu_pairings SET expires_at=?, body=? WHERE seq=?')
      .run(record.expiresAt, JSON.stringify(record), seq)
  }

  /** 没绑定的人私聊机器人：回配对码（同步写库，回复在后台发） */
  requested(appId: string, request: PairingRequest): void {
    const { store } = this.options
    const now = this.options.now()
    if (this.bound(appId, request.openId)) return
    const result = store.transaction(() => {
      const pending = this.pendings(appId)
      const mine = pending.find((one) => one.record.openId === request.openId)
      if (mine) {
        const { seq, record } = mine
        const known = this.codes.get(seq)
        if (known && now - record.sentAt < RESEND_AFTER) return null
        const code = known ?? newCode()
        const salt = known ? record.salt : randomBytes(16).toString('hex')
        const next: PairingRecord = {
          ...record,
          salt,
          codeHash: known ? record.codeHash : hash(salt, code).toString('hex'),
          chatId: request.chatId,
          sentAt: now,
          sends: record.sends + 1,
        }
        this.savePairing(seq, next)
        this.codes.set(seq, code)
        return { seq, code, sends: next.sends, chatId: request.chatId }
      }
      if (pending.length >= PENDING_MAX) {
        const last = this.limited.get(appId) ?? 0
        if (now - last >= PAIRING_TTL) {
          this.limited.set(appId, now)
          store.audit(appId, now, { action: 'pairing_limited', by: 'device' })
        }
        return null
      }
      const code = newCode()
      const salt = randomBytes(16).toString('hex')
      const record: PairingRecord = {
        appId,
        openId: request.openId,
        ...(request.unionId ? { unionId: request.unionId } : {}),
        ...(request.userId ? { userId: request.userId } : {}),
        chatId: request.chatId,
        salt,
        codeHash: hash(salt, code).toString('hex'),
        createdAt: now,
        expiresAt: now + PAIRING_TTL,
        sentAt: now,
        sends: 1,
      }
      const inserted = this.db
        .prepare(
          "INSERT INTO feishu_pairings(app_id, open_id, state, expires_at, body) VALUES(?,?,'pending',?,?)",
        )
        .run(appId, request.openId, record.expiresAt, JSON.stringify(record))
      const seq = Number(inserted.lastInsertRowid)
      this.codes.set(seq, code)
      store.audit(appId, now, { action: 'pairing_requested', by: 'device' })
      return { seq, code, sends: 1, chatId: request.chatId, fresh: true }
    })
    if (!result) return
    this.changed(appId)
    this.background(async () => {
      if ('fresh' in result) await this.enrichName(appId, result.seq, request.openId)
      await this.system(
        appId,
        result.chatId,
        PAIRING_TEXT(result.code),
        `pair-${result.seq}-${result.sends}`,
      )
    })
  }

  /** 名字：通讯录查得到用通讯录的，否则用群成员表里的 */
  private async nameOf(appId: string, openId: string): Promise<string> {
    const api = this.options.api(appId)
    if (api) {
      try {
        const data = await api.data(
          'GET',
          `/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
          {
            query: { user_id_type: 'open_id' },
          },
        )
        const user = data.user as Record<string, unknown> | undefined
        if (typeof user?.name === 'string' && user.name) return user.name.slice(0, 256)
      } catch {}
    }
    return this.options.messages.personName(appId, openId) ?? ''
  }

  private async enrichName(appId: string, seq: number, openId: string): Promise<void> {
    const name = await this.nameOf(appId, openId)
    if (!name) return
    const row = this.db.prepare('SELECT body FROM feishu_pairings WHERE seq=?').get(seq)
    if (!row) return
    const record = JSON.parse(String(row.body)) as PairingRecord
    this.savePairing(seq, { ...record, name })
  }

  private find(appId: string, code: string): { seq: number; record: PairingRecord } | null {
    const wanted = normalizeCode(code)
    if (wanted.length !== 8) return null
    for (const one of this.pendings(appId)) {
      const expected = Buffer.from(one.record.codeHash, 'hex')
      const actual = hash(one.record.salt, wanted)
      if (expected.length === actual.length && timingSafeEqual(expected, actual)) return one
    }
    return null
  }

  lookup(appId: string, code: string): FeishuPairing {
    if (!this.options.store.app(appId)) this.options.fail('feishu_app_not_found')
    const found = this.find(appId, code) ?? this.options.fail('feishu_pairing_not_found')
    return pairingView(found.record)
  }

  /** 确认配对：绑定，回一句“已绑定” */
  async approve(appId: string, code: string): Promise<FeishuBinding> {
    const { store, fail } = this.options
    if (!store.app(appId)) fail('feishu_app_not_found')
    const before = this.find(appId, code) ?? fail('feishu_pairing_not_found')
    const name = before.record.name || (await this.nameOf(appId, before.record.openId))
    const now = this.options.now()
    const binding = store.transaction(() => {
      // 等名字的时候可能已被别人批了或过期了：重新找一次
      const found = this.find(appId, code) ?? fail('feishu_pairing_not_found')
      const { record } = found
      this.db.prepare("UPDATE feishu_pairings SET state='approved' WHERE seq=?").run(found.seq)
      const current = this.record(appId, record.openId)
      const hasApprover = this.records(appId).some(
        (one) => one.state === 'bound' && one.approver && one.openId !== record.openId,
      )
      const next: BindingRecord = {
        appId,
        openId: record.openId,
        revision: (current?.revision ?? 0) + 1,
        name,
        ...(record.unionId ? { unionId: record.unionId } : {}),
        ...(record.userId ? { userId: record.userId } : {}),
        state: 'bound',
        approver: !hasApprover,
        retentionDays: current?.retentionDays ?? FEISHU_RETENTION_DAYS.default,
        boundAt: now,
        p2pChatId: record.chatId,
      }
      this.save(next)
      store.audit(appId, now, {
        action: 'binding_approved',
        by: 'admin',
        detail: { approver: next.approver },
      })
      this.codes.delete(found.seq)
      return next
    })
    this.changed(appId, binding.openId)
    if (binding.p2pChatId) {
      const chatId = binding.p2pChatId
      this.background(() =>
        this.system(
          appId,
          chatId,
          BOUND_TEXT,
          `bound-${binding.openId.slice(3, 30)}-${binding.revision}`,
        ),
      )
    }
    return view(binding)
  }

  revoke(appId: string, openId: string, expectedRevision: number): FeishuBinding {
    const { store, fail } = this.options
    const now = this.options.now()
    const next = store.transaction(() => {
      const current = this.record(appId, openId) ?? fail('feishu_binding_not_found')
      if (current.revision !== expectedRevision) fail('feishu_revision_conflict')
      if (current.state === 'revoked') fail('feishu_binding_revoked')
      const updated: BindingRecord = {
        ...current,
        revision: current.revision + 1,
        state: 'revoked',
        approver: false,
        revokedAt: now,
      }
      this.save(updated)
      store.audit(appId, now, { action: 'binding_revoked', by: 'admin' })
      return updated
    })
    this.changed(appId, openId)
    return view(next)
  }

  update(
    appId: string,
    openId: string,
    expectedRevision: number,
    patch: { approver?: boolean; retentionDays?: number },
  ): BindingRecord {
    const { store, fail } = this.options
    const now = this.options.now()
    const next = store.transaction(() => {
      const current = this.record(appId, openId) ?? fail('feishu_binding_not_found')
      if (current.revision !== expectedRevision) fail('feishu_revision_conflict')
      if (patch.approver && current.state !== 'bound') fail('feishu_binding_revoked')
      const updated: BindingRecord = {
        ...current,
        revision: current.revision + 1,
        ...(patch.approver === undefined ? {} : { approver: patch.approver }),
        ...(patch.retentionDays === undefined ? {} : { retentionDays: patch.retentionDays }),
      }
      this.save(updated)
      store.audit(appId, now, {
        action: 'binding_updated',
        by: 'admin',
        detail: {
          ...(patch.approver === undefined ? {} : { approver: patch.approver }),
          ...(patch.retentionDays === undefined ? {} : { retentionDays: patch.retentionDays }),
        },
      })
      return updated
    })
    this.changed(appId, openId)
    return next
  }

  /** 移除应用时一起删 */
  removeApp(appId: string): void {
    this.db.prepare('DELETE FROM feishu_bindings WHERE app_id=?').run(appId)
    this.db.prepare('DELETE FROM feishu_pairings WHERE app_id=?').run(appId)
    this.db.prepare('DELETE FROM feishu_review_notices WHERE app_id=?').run(appId)
  }

  // —— 系统消息 ——

  private background(work: () => Promise<void>): void {
    const running = work().catch((error: Error) =>
      this.options.log(`飞书私聊系统消息发送失败：${error.message}`),
    )
    this.sending.add(running)
    void running.finally(() => this.sending.delete(running))
  }

  /** 配对码、已绑定：不走发件队列和审批，带去重标识发一次 */
  private async system(appId: string, chatId: string, text: string, uuid: string): Promise<void> {
    const api = this.options.api(appId)
    if (!api) return
    await api.data('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: 'chat_id' },
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }), uuid },
    })
  }

  /** 测试：等后台的系统消息发完 */
  async idle(): Promise<void> {
    while (this.sending.size > 0) await Promise.allSettled([...this.sending])
  }
}

function view(record: BindingRecord): FeishuBinding {
  const { p2pChatId: _chat, ...binding } = record
  return binding
}

function pairingView(record: PairingRecord): FeishuPairing {
  return {
    appId: record.appId,
    openId: record.openId,
    ...(record.name ? { name: record.name } : {}),
    ...(record.unionId ? { unionId: record.unionId } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  }
}

export const bindingView = view
