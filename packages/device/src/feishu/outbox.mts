// 飞书发件队列：经理的每次发言一行。入队时就把最终消息体冻结成私有文件并记哈希，审批看的、最后发出去的是同一份字节。
// 自由发言的群直接排队；审批发言的群先建 litchReviews 审批，批了再排队。每个应用一条串行发送通道。
// 每条分片带 uuid（操作 ID + 序号），飞书一小时内按 uuid 去重；网络中断等结果不明时标 unknown，一小时内自动重发，
// 超过一小时还不明就停下等人核对。发成的消息按 source=sent 记进消息库。
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type {
  FeishuCliRequest,
  FeishuOutboxEntry,
  FeishuOutboxFormat,
  FeishuOutboxState,
  FeishuPerson,
} from '../../../protocol/src/feishu.mjs'
import type { Review, ReviewSpeechPart } from '../../../protocol/src/reviews.mjs'
import type { DeviceReviews } from '../reviews.mjs'
import { FeishuApiError } from './api.mjs'
import type { FeishuChats } from './chats.mjs'
import { FEISHU_SPEECH_PROVIDER } from './chats.mjs'
import type { ImMessages } from './messages.mjs'
import type { FeishuRecords } from './records.mjs'
import { buildTextSpeech, SPEECH_TEXT_MAX, type SpeechPart } from './speech.mjs'
import type { SpeechPolicies } from './speech-policy.mjs'
import type { FeishuAppRecord, FeishuAuditAction, FeishuStore } from './store.mjs'

export const FEISHU_OUTBOX_MIGRATION = `
CREATE TABLE feishu_outbox(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, app_id TEXT NOT NULL,
  manager_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL
);
CREATE INDEX feishu_outbox_app ON feishu_outbox(app_id, state, seq);
CREATE INDEX feishu_outbox_manager ON feishu_outbox(manager_id, seq);
`

/** 冻结的载荷放在设备状态目录下的这里（0700，文件 0600） */
export const FEISHU_OUTBOX_DIRECTORY = 'feishu-outbox'
const IMAGE_MAX = 10 * 1024 * 1024
const FILE_MAX = 30 * 1024 * 1024
/** 结果不明时，从第一次发送起一小时内自动重发（飞书 uuid 去重窗口） */
const UNKNOWN_WINDOW = 3600
const RETRY_BASE = 30
const RETRY_MAX = 600
const SUMMARY_MAX = 200
/** 发完的行留多久（秒） */
const KEEP_FINISHED = 90 * 86_400

/** 库里存的发件行：公开字段加上设备自己用的 */
export interface OutboxRecord extends FeishuOutboxEntry {
  threadId?: string
  turnId?: string
  payloadHash: string
  /** 图片、文件上传后的 key，按分片序号 */
  uploaded?: Record<string, string>
  firstAttemptAt?: number
  nextAttemptAt?: number
  /** 结果已经随投递告诉过经理 */
  reported?: boolean
}

export interface OutboxSubmit {
  app: FeishuAppRecord
  managerId: string
  threadId?: string
  turnId?: string
  operationId?: string
  target: { kind: 'chat'; chatId: string } | { kind: 'user'; openId: string }
  replyTo?: string
  text?: string
  format?: 'auto' | 'text' | 'post' | 'card'
  title?: string
  imagePath?: string
  filePath?: string
  /** 名字或 open_id */
  mentions?: string[]
}

export interface FeishuOutboxOptions {
  stateDirectory: string
  store: FeishuStore
  chats: FeishuChats
  messages: ImMessages
  records: FeishuRecords
  policies: SpeechPolicies
  reviews: DeviceReviews | null
  api: (appId: string) => import('./api.mjs').FeishuApi | null
  /** 秒 */
  now: () => number
  log: (message: string) => void
  /** 发件行变了 */
  changed: (appId: string, operationId: string) => void
  /** 两次发送之间至少隔多久（毫秒），守飞书单群 5 QPS */
  gapMs?: number
  /** 到期重试的检查间隔（毫秒） */
  tickMs?: number
}

/** 解析好的发言目标 */
export interface OutboxTarget {
  kind: 'chat' | 'user'
  id: string
  name: string
  chatId: string
  mode: 'free' | 'approval'
  reviewTtlHours: number
}

/** lark-cli 拦下转审批的原始请求 */
export interface OutboxCliSubmit {
  app: FeishuAppRecord
  managerId: string
  threadId?: string
  target: OutboxTarget
  replyTo?: string
  cli: FeishuCliRequest
  raw: { method: string; pathAndQuery: string; contentType?: string; body: Buffer }
  msgType: SpeechPart['msgType']
  format: FeishuOutboxFormat
  summary: string
  preview: ReviewSpeechPart[]
}

/** 入参或状态不对：消息就是给经理看的原因 */
export class OutboxRefusal extends Error {}
const refuse = (message: string): never => {
  throw new OutboxRefusal(message)
}

/** 已绑定用户（F6 接上）；没绑定的是 null */
export type FeishuBindingLookup = (
  appId: string,
  openId: string,
) => { name: string; p2pChatId?: string } | null

const FINISHED: ReadonlySet<FeishuOutboxState> = new Set(['sent', 'failed', 'rejected', 'canceled'])

export class FeishuOutbox {
  protected readonly options: FeishuOutboxOptions
  /** 已绑定用户（F6 接上）：私聊发言只发给他们 */
  bound: FeishuBindingLookup = () => null
  protected readonly drains = new Map<string, Promise<void>>()
  protected timer: NodeJS.Timeout | null = null
  protected closed = false

  constructor(options: FeishuOutboxOptions) {
    this.options = options
  }

  protected get db() {
    return this.options.store.managers.db
  }

  protected get directory(): string {
    return join(this.options.stateDirectory, FEISHU_OUTBOX_DIRECTORY)
  }

  // —— 存取 ——

  get(operationId: string): OutboxRecord | null {
    const row = this.db
      .prepare('SELECT body FROM feishu_outbox WHERE operation_id=?')
      .get(operationId)
    return row ? (JSON.parse(String(row.body)) as OutboxRecord) : null
  }

  protected save(record: OutboxRecord): void {
    this.db
      .prepare('UPDATE feishu_outbox SET state=?, body=? WHERE operation_id=?')
      .run(record.state, JSON.stringify(record), record.operationId)
  }

  list(appId: string, states: FeishuOutboxState[] | undefined, limit: number, before?: string) {
    const where = ['app_id=?']
    const values: (string | number)[] = [appId]
    if (states?.length) {
      where.push(`state IN (${states.map(() => '?').join(',')})`)
      values.push(...states)
    }
    if (before) {
      where.push('seq < (SELECT seq FROM feishu_outbox WHERE operation_id=?)')
      values.push(before)
    }
    return this.db
      .prepare(
        `SELECT body FROM feishu_outbox WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...values, limit)
      .map((row) => JSON.parse(String(row.body)) as OutboxRecord)
  }

  /** 给界面和工具的公开样子 */
  view(record: OutboxRecord): FeishuOutboxEntry {
    const {
      threadId: _thread,
      turnId: _turn,
      payloadHash: _hash,
      uploaded: _uploaded,
      firstAttemptAt: _first,
      nextAttemptAt: _next,
      reported: _reported,
      ...entry
    } = record
    return entry
  }

  // —— 入队 ——

  /** 经理发言：校验目标与 @、冻结载荷、按发言模式排队或转审批 */
  async submit(input: OutboxSubmit): Promise<OutboxRecord> {
    if (input.operationId) {
      const existing = this.get(input.operationId)
      if (existing) {
        if (existing.managerId !== input.managerId || existing.appId !== input.app.appId)
          refuse('operationId is already used.')
        return existing
      }
    }
    const operationId = input.operationId ?? `fs_${randomBytes(15).toString('base64url')}`
    const { app } = input
    const target = this.resolveTarget(app, input.target)
    const mentions =
      input.mentions?.length && target.kind === 'chat'
        ? await this.resolveMentions(app.appId, target.id, input.mentions)
        : input.mentions?.length
          ? refuse('mentions only work in group chats.')
          : []
    if (input.replyTo !== undefined) {
      const parent = this.options.messages.get(app.appId, input.replyTo)
      if (!parent || parent.chatId !== target.chatId)
        refuse('replyTo must be a recorded message of the same chat.')
    }
    const built = this.build(input, mentions)
    const folder = join(this.directory, operationId)
    const payloadHash = this.freeze(folder, built.parts, input.imagePath ?? input.filePath)
    return this.persist({
      operationId,
      app,
      managerId: input.managerId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      target,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      format: built.format,
      summary: built.summary,
      parts: built.parts.length,
      mentions,
      preview: built.preview,
      payloadHash,
      folder,
    })
  }

  /**
   * lark-cli 拦下的发言（审批发言的群）：原始请求原样冻结，转审批；批了原样发。
   * 自由发言的群、私聊由代理直接转发，不进这里。
   */
  submitCli(input: OutboxCliSubmit): OutboxRecord {
    if (input.target.mode !== 'approval') refuse('Only approval chats queue lark-cli requests.')
    const operationId = `fs_${randomBytes(15).toString('base64url')}`
    const folder = join(this.directory, operationId)
    const part: SpeechPart = {
      msgType: input.msgType,
      raw: {
        method: input.raw.method,
        pathAndQuery: input.raw.pathAndQuery,
        ...(input.raw.contentType ? { contentType: input.raw.contentType } : {}),
        file: 'attachment',
      },
    }
    const payloadHash = this.freeze(folder, [part], undefined, input.raw.body)
    return this.persist({
      operationId,
      app: input.app,
      managerId: input.managerId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      target: input.target,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      format: input.format,
      summary: input.summary.slice(0, SUMMARY_MAX),
      parts: 1,
      mentions: [],
      preview: input.preview,
      payloadHash,
      folder,
      cli: input.cli,
    })
  }

  /** 写进库：审批发言的群同时建审批；失败时删掉冻结目录 */
  private persist(input: {
    operationId: string
    app: FeishuAppRecord
    managerId: string
    threadId?: string
    turnId?: string
    target: OutboxTarget
    replyTo?: string
    format: FeishuOutboxFormat
    summary: string
    parts: number
    mentions: FeishuPerson[]
    preview: ReviewSpeechPart[]
    payloadHash: string
    folder: string
    cli?: FeishuCliRequest
  }): OutboxRecord {
    const { operationId, app, target, mentions, payloadHash } = input
    const now = this.options.now()
    const record: OutboxRecord = {
      operationId,
      appId: app.appId,
      managerId: input.managerId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      target: { kind: target.kind, id: target.id, name: target.name },
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      format: input.format,
      summary: input.summary,
      parts: input.parts,
      messageIds: [],
      mentions,
      state: 'queued',
      attempts: 0,
      payloadHash,
      createdAt: now,
      updatedAt: now,
      ...(input.cli ? { cli: input.cli } : {}),
    }
    let review: Review | null = null
    try {
      this.options.store.transaction(() => {
        if (this.get(operationId)) refuse('operationId is already used.')
        this.db
          .prepare(
            'INSERT INTO feishu_outbox(operation_id, app_id, manager_id, state, body) VALUES(?,?,?,?,?)',
          )
          .run(operationId, app.appId, input.managerId, 'queued', '{}')
        if (target.mode === 'approval') {
          const reviews = this.options.reviews ?? refuse('Approval is unavailable on this device.')
          review = reviews.create({
            kind: 'speech',
            provider: FEISHU_SPEECH_PROVIDER,
            scope: `${app.appId}/${target.id}`,
            subjectRef: operationId,
            requestedBy: {
              managerId: input.managerId,
              ...(input.threadId ? { threadId: input.threadId } : {}),
              ...(input.turnId ? { turnId: input.turnId } : {}),
            },
            preview: {
              kind: 'speech',
              provider: 'feishu',
              appId: app.appId,
              appName: app.name,
              target: { kind: target.kind, id: target.id, name: target.name },
              ...(input.replyTo ? { replyTo: this.replyPreview(app.appId, input.replyTo) } : {}),
              actingAs: { type: 'bot' },
              mentions,
              parts: input.preview,
              ...(input.cli ? { cli: input.cli } : {}),
            },
            payloadHash,
            expiresAt: now + target.reviewTtlHours * 3600,
          })
          record.state = 'awaiting_approval'
          record.reviewId = review.reviewId
        }
        this.save(record)
        this.options.store.audit(app.appId, now, {
          action: 'speech_requested',
          by: 'device',
          detail: {
            operationId,
            target: target.id,
            mode: target.mode,
            parts: record.parts,
            reviewId: record.reviewId ?? null,
            ...(input.cli ? { cli: input.cli.action } : {}),
          },
        })
      })
    } catch (error) {
      rmSync(input.folder, { recursive: true, force: true })
      throw error
    }
    if (review) this.options.reviews?.announce(review)
    this.options.changed(app.appId, operationId)
    if (record.state === 'queued') this.kick(app.appId)
    return record
  }

  /** 发言目标：已接入的群（按发言模式）或已绑定用户的私聊（自由发言）；不行就拒绝 */
  resolveTarget(app: FeishuAppRecord, wanted: OutboxSubmit['target']): OutboxTarget {
    if (wanted.kind === 'user') {
      const user = this.bound(app.appId, wanted.openId)
      if (!user?.p2pChatId) return refuse('The user is not bound to this Feishu app.')
      // 私聊只和已绑定的人聊，固定自由发言（D-158）
      return {
        kind: 'user' as const,
        id: wanted.openId,
        name: user.name,
        chatId: user.p2pChatId,
        mode: 'free' as const,
        reviewTtlHours: 24,
      }
    }
    const chatId = wanted.chatId
    const chat = this.options.chats.record(app.appId, chatId)
    if (!chat?.access) return refuse('The chat is not accessed in Litch.')
    if (!chat.botPresent) return refuse('The bot is no longer in this chat.')
    if (chat.status !== 'normal') return refuse('The chat was disbanded.')
    const mode = this.options.policies.decide(FEISHU_SPEECH_PROVIDER, `${app.appId}/${chatId}`)
    if (mode === 'denied') return refuse('Speaking in this chat is not allowed.')
    return {
      kind: 'chat' as const,
      id: chatId,
      name: chat.name,
      chatId,
      mode,
      reviewTtlHours: chat.access.reviewTtlHours,
    }
  }

  /** 名字或 open_id 按本群成员表解析；对不上或不唯一就拒绝，不猜 */
  private async resolveMentions(
    appId: string,
    chatId: string,
    wanted: string[],
  ): Promise<FeishuPerson[]> {
    if (wanted.length > 20) refuse('At most 20 mentions.')
    let members = this.options.messages
      .members(appId, chatId)
      .filter((one) => one.present)
      .map(({ openId, name }) => ({ openId, name }))
    if (members.length === 0)
      members = (await this.options.chats.memberList(appId, chatId, false)).members
    const found: FeishuPerson[] = []
    for (const raw of wanted) {
      const value = raw.trim()
      const byId = members.find((one) => one.openId === value)
      const named = byId ? [byId] : members.filter((one) => one.name === value)
      if (named.length === 0) refuse(`No member of this chat matches ${value}.`)
      if (named.length > 1)
        refuse(
          `Several members are named ${value}: ${named.map((one) => one.openId).join(', ')}. Use open_id.`,
        )
      const person = named[0] as FeishuPerson
      if (!found.some((one) => one.openId === person.openId)) found.push(person)
    }
    return found
  }

  private replyPreview(appId: string, messageId: string) {
    const text = this.options.messages.get(appId, messageId)?.text
    return { messageId, ...(text ? { text: text.slice(0, 1000) } : {}) }
  }

  private build(
    input: OutboxSubmit,
    mentions: FeishuPerson[],
  ): {
    format: FeishuOutboxFormat
    parts: SpeechPart[]
    preview: ReviewSpeechPart[]
    summary: string
  } {
    const given = [input.text, input.imagePath, input.filePath].filter((one) => one !== undefined)
    if (given.length !== 1) refuse('Give exactly one of text, imagePath or filePath.')
    if (input.text !== undefined) {
      if (!input.text.trim()) refuse('text is empty.')
      if (input.text.length > SPEECH_TEXT_MAX)
        refuse(`text is longer than ${SPEECH_TEXT_MAX} characters.`)
      const built = buildTextSpeech(input.format ?? 'auto', input.text, mentions, input.title)
      return { ...built, summary: input.text.trim().slice(0, SUMMARY_MAX) }
    }
    if (mentions.length) refuse('mentions only work with text.')
    if (input.title !== undefined) refuse('title only works with text.')
    const kind = input.imagePath !== undefined ? 'image' : 'file'
    const path = (input.imagePath ?? input.filePath) as string
    if (!isAbsolute(path)) refuse(`${kind}Path must be an absolute path on this device.`)
    let size: number
    try {
      const stat = statSync(path)
      if (!stat.isFile()) refuse(`${path} is not a file.`)
      size = stat.size
    } catch (error) {
      if (error instanceof OutboxRefusal) throw error
      return refuse(`Cannot read ${path}.`)
    }
    const max = kind === 'image' ? IMAGE_MAX : FILE_MAX
    if (size === 0 || size > max) refuse(`The ${kind} must be 1 byte to ${max / 1024 / 1024} MB.`)
    const name = basename(path).slice(0, 200)
    return {
      format: kind,
      parts: [{ msgType: kind, upload: { kind, file: 'attachment', name, size } }],
      preview: [{ format: kind, name, size }],
      summary: name,
    }
  }

  /** 载荷写进私有目录；图片、文件复制一份，原始请求体写成附件。返回哈希（载荷加附件的字节） */
  private freeze(folder: string, parts: SpeechPart[], source?: string, body?: Buffer): string {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    chmodSync(this.directory, 0o700)
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { mode: 0o700 })
    const payload = Buffer.from(JSON.stringify({ parts }))
    writeFileSync(join(folder, 'payload.json'), payload, { mode: 0o600 })
    if (body !== undefined) writeFileSync(join(folder, 'attachment'), body, { mode: 0o600 })
    else if (source !== undefined) {
      const copy = join(folder, 'attachment')
      try {
        copyFileSync(source, copy)
      } catch {
        rmSync(folder, { recursive: true, force: true })
        refuse(`Cannot read ${source}.`)
      }
      chmodSync(copy, 0o600)
    }
    return this.hash(folder)
  }

  private hash(folder: string): string {
    const digest = createHash('sha256').update(readFileSync(join(folder, 'payload.json')))
    try {
      digest.update(readFileSync(join(folder, 'attachment')))
    } catch {
      // 文字类没有附件
    }
    return digest.digest('hex')
  }

  /** 读回冻结的载荷；文件不在或哈希对不上返回 null */
  private thaw(record: OutboxRecord): { folder: string; parts: SpeechPart[] } | null {
    const folder = join(this.directory, record.operationId)
    try {
      if (this.hash(folder) !== record.payloadHash) return null
      const parsed = JSON.parse(readFileSync(join(folder, 'payload.json'), 'utf8')) as {
        parts: SpeechPart[]
      }
      return { folder, parts: parsed.parts }
    } catch {
      return null
    }
  }

  // —— 撤下与审批结果 ——

  /** 撤下还没发出的（含待审批的）；已发出的、正在发的不撤 */
  cancel(operationId: string, by: 'manager' | 'admin'): OutboxRecord {
    let review: Review | null = null
    const next = this.options.store.transaction(() => {
      const record = this.get(operationId) ?? refuse('No such send operation.')
      if (record.state === 'sending') refuse('The message is being sent now.')
      if (FINISHED.has(record.state)) return record
      if (record.reviewId)
        review = this.options.reviews?.cancelInTransaction(record.reviewId, 'canceled') ?? null
      const updated = this.finish(record, 'canceled', `canceled_by_${by}`)
      this.audit(updated, 'speech_canceled')
      return updated
    })
    if (review) this.options.reviews?.announce(review)
    this.options.changed(next.appId, operationId)
    return next
  }

  /** 审批有了结果（在审批的事务里）：批准就排队，其余收掉 */
  reviewSettled(review: Review): void {
    const record = this.get(review.subjectRef)
    if (!record || record.state !== 'awaiting_approval' || record.reviewId !== review.reviewId)
      return
    if (review.state === 'approved') {
      this.save({ ...record, state: 'queued', updatedAt: this.options.now() })
    } else if (review.state === 'rejected') {
      this.finish(record, 'rejected', 'review_rejected')
    } else this.finish(record, 'canceled', `review_${review.state}`)
    this.audit(record, `speech_review_${review.state}`)
  }

  /** 审批结果提交以后：通知并开始发送 */
  reviewAfter(review: Review): void {
    const record = this.get(review.subjectRef)
    if (!record) return
    this.options.changed(record.appId, record.operationId)
    if (record.state === 'queued') this.kick(record.appId)
  }

  private finish(record: OutboxRecord, state: FeishuOutboxState, error?: string): OutboxRecord {
    const updated: OutboxRecord = { ...record, state, updatedAt: this.options.now() }
    delete updated.nextAttemptAt
    if (error) updated.error = error
    else delete updated.error
    if (state === 'sent') updated.sentAt = updated.updatedAt
    this.save(updated)
    if (FINISHED.has(state))
      rmSync(join(this.directory, record.operationId), { recursive: true, force: true })
    return updated
  }

  private audit(record: OutboxRecord, action: string): void {
    this.options.store.audit(record.appId, this.options.now(), {
      action: action as FeishuAuditAction,
      by: 'device',
      detail: {
        operationId: record.operationId,
        state: record.state,
        messages: record.messageIds.length,
        ...(record.error ? { error: record.error } : {}),
      },
    })
  }

  /** 还没告诉过经理的结果（被拒、撤下、过期、失败、结果不明且不再重试） */
  unreported(managerId: string): OutboxRecord[] {
    return this.db
      .prepare(
        `SELECT body FROM feishu_outbox WHERE manager_id=? AND state IN ('failed','rejected','canceled','unknown')
         ORDER BY seq`,
      )
      .all(managerId)
      .map((row) => JSON.parse(String(row.body)) as OutboxRecord)
      .filter(
        (record) =>
          !record.reported &&
          !record.error?.startsWith('canceled_by_') &&
          (record.state !== 'unknown' || record.nextAttemptAt === undefined),
      )
  }

  /** 在投递的事务里标成已告诉 */
  markReported(operationIds: string[], reported: boolean): void {
    for (const operationId of operationIds) {
      const record = this.get(operationId)
      if (!record || !!record.reported === reported) continue
      const next = { ...record }
      if (reported) next.reported = true
      else delete next.reported
      this.save(next)
    }
  }

  // —— 发送 ——

  start(): void {
    // 上次停在“正在发”的：结果不明，按 unknown 在一小时窗口里重发
    for (const row of this.db
      .prepare("SELECT body FROM feishu_outbox WHERE state='sending'")
      .all()) {
      const record = JSON.parse(String(row.body)) as OutboxRecord
      this.save({ ...record, state: 'unknown', nextAttemptAt: this.options.now() })
    }
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 30_000)
    this.timer.unref()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 到期的重试、过期的审批、过久的旧行 */
  tick(): void {
    if (this.closed) return
    this.options.reviews?.expire()
    const now = this.options.now()
    const due = this.db
      .prepare("SELECT DISTINCT app_id FROM feishu_outbox WHERE state IN ('queued','unknown')")
      .all()
      .map((row) => String(row.app_id))
    for (const appId of due) this.kick(appId)
    this.db
      .prepare(
        `DELETE FROM feishu_outbox WHERE state IN ('sent','failed','rejected','canceled')
         AND json_extract(body, '$.updatedAt') < ?`,
      )
      .run(now - KEEP_FINISHED)
  }

  /** 应用的发送通道：没在跑就起一个 */
  kick(appId: string): void {
    if (this.closed || this.drains.has(appId)) return
    const run = this.drain(appId)
      .catch((error: Error) => this.options.log(`飞书发件出错：${error.message}`))
      .finally(() => this.drains.delete(appId))
    this.drains.set(appId, run)
  }

  /** 等发送通道都停下（测试用） */
  async idle(): Promise<void> {
    while (this.drains.size) await Promise.allSettled([...this.drains.values()])
  }

  private firstDue(appId: string, now: number): OutboxRecord | null {
    for (const row of this.db
      .prepare(
        "SELECT body FROM feishu_outbox WHERE app_id=? AND state IN ('queued','unknown') ORDER BY seq",
      )
      .all(appId)) {
      const record = JSON.parse(String(row.body)) as OutboxRecord
      // 结果不明且已过重发窗口的停下等人
      if (record.state === 'unknown' && record.nextAttemptAt === undefined) continue
      if ((record.nextAttemptAt ?? 0) <= now) return record
    }
    return null
  }

  private async drain(appId: string): Promise<void> {
    for (;;) {
      if (this.closed) return
      const record = this.firstDue(appId, this.options.now())
      if (!record) return
      await this.sendOne(record)
      const gap = this.options.gapMs ?? 250
      if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
    }
  }

  /** 发送前再查一次：应用启用、群仍接入、机器人在群里、审批仍是批准且哈希一致 */
  private blocked(record: OutboxRecord): string | null {
    const app = this.options.store.app(record.appId)
    if (!app?.enabled) return 'app_inactive'
    if (record.target.kind === 'chat') {
      const chat = this.options.chats.record(record.appId, record.target.id)
      if (!chat?.access || !chat.botPresent || chat.status !== 'normal') return 'chat_unavailable'
    } else if (!this.bound(record.appId, record.target.id)) return 'user_unbound'
    if (record.reviewId) {
      const review = this.options.reviews?.get(record.reviewId)
      if (review?.state !== 'approved' || review.payloadHash !== record.payloadHash)
        return 'review_mismatch'
    }
    return null
  }

  private async sendOne(record: OutboxRecord): Promise<void> {
    const reason = this.blocked(record)
    const frozen = reason ? null : this.thaw(record)
    const api = this.options.api(record.appId)
    if (reason || !frozen || !api) {
      const failed = this.finish(
        record,
        'failed',
        reason ?? (frozen ? 'app_inactive' : 'payload_changed'),
      )
      this.audit(failed, 'speech_failed')
      this.options.changed(record.appId, record.operationId)
      return
    }
    const now = this.options.now()
    let current: OutboxRecord = {
      ...record,
      state: 'sending',
      attempts: record.attempts + 1,
      firstAttemptAt: record.firstAttemptAt ?? now,
      updatedAt: now,
    }
    delete current.nextAttemptAt
    this.save(current)
    this.options.changed(record.appId, record.operationId)
    const chatKind = record.target.kind === 'chat' ? 'group' : 'p2p'
    try {
      for (let index = current.messageIds.length; index < frozen.parts.length; index++) {
        const part = frozen.parts[index] as SpeechPart
        if (part.raw) {
          const item = await this.forwardRaw(api, frozen.folder, part.raw)
          const messageId = typeof item?.message_id === 'string' ? item.message_id : ''
          if (messageId) current = { ...current, messageIds: [...current.messageIds, messageId] }
          this.save(current)
          if (item && messageId && typeof item.chat_id === 'string')
            try {
              this.options.records.storeSent(record.appId, item, chatKind)
            } catch (error) {
              this.options.log(`飞书发出的消息记录失败：${(error as Error).message}`)
            }
          continue
        }
        let content = part.content ?? ''
        if (part.upload) {
          const key =
            current.uploaded?.[index] ?? (await this.upload(api, frozen.folder, part.upload))
          current = { ...current, uploaded: { ...current.uploaded, [index]: key } }
          this.save(current)
          content = JSON.stringify(
            part.upload.kind === 'image' ? { image_key: key } : { file_key: key },
          )
        }
        const item = await this.post(api, current, part.msgType, content, index)
        const messageId = typeof item.message_id === 'string' ? item.message_id : ''
        if (!messageId) throw new FeishuApiError('platform')
        current = { ...current, messageIds: [...current.messageIds, messageId] }
        this.save(current)
        try {
          this.options.records.storeSent(record.appId, item, chatKind)
        } catch (error) {
          this.options.log(`飞书发出的消息记录失败：${(error as Error).message}`)
        }
      }
      const sent = this.finish(current, 'sent')
      this.audit(sent, 'speech_sent')
    } catch (error) {
      this.failed(current, error)
    }
    this.options.changed(record.appId, record.operationId)
  }

  private failed(record: OutboxRecord, error: unknown): void {
    const kind = error instanceof FeishuApiError ? error.kind : 'invalid'
    const now = this.options.now()
    // lark-cli 的原始请求不一定带去重的 uuid：结果不明时不自动重发，停下等人核对
    if (kind === 'network' && record.cli) {
      const next: OutboxRecord = { ...record, state: 'unknown', updatedAt: now }
      delete next.nextAttemptAt
      next.error = 'unknown_timeout'
      this.save(next)
      this.audit(next, 'speech_unknown')
      return
    }
    if (kind === 'network') {
      // 结果不明：一小时内带同一个 uuid 重发，飞书去重；之后停下等人核对
      const elapsed = now - (record.firstAttemptAt ?? now)
      const delay = Math.min(RETRY_MAX, RETRY_BASE * 2 ** Math.max(0, record.attempts - 1))
      const next: OutboxRecord = { ...record, state: 'unknown', updatedAt: now }
      if (elapsed + delay < UNKNOWN_WINDOW) {
        next.nextAttemptAt = now + delay
        delete next.error
      } else {
        delete next.nextAttemptAt
        next.error = 'unknown_timeout'
        this.audit(next, 'speech_unknown')
      }
      this.save(next)
      return
    }
    if (kind === 'rate_limited') {
      const retryAt = error instanceof FeishuApiError ? error.retryAt : undefined
      this.save({
        ...record,
        state: 'queued',
        updatedAt: now,
        nextAttemptAt: retryAt ? Math.ceil(retryAt / 1000) : now + RETRY_BASE,
      })
      return
    }
    const failed = this.finish(record, 'failed', kind)
    this.audit(failed, 'speech_failed')
  }

  private async post(
    api: import('./api.mjs').FeishuApi,
    record: OutboxRecord,
    msgType: string,
    content: string,
    index: number,
  ): Promise<Record<string, unknown>> {
    const body = { msg_type: msgType, content, uuid: `${record.operationId}-${index}` }
    if (record.replyTo) {
      try {
        return await api.data(
          'POST',
          `/open-apis/im/v1/messages/${encodeURIComponent(record.replyTo)}/reply`,
          { body },
        )
      } catch (error) {
        // 回复对象没了等平台拒绝：改成直接发；网络、限流、凭据的照常往上抛
        if (
          !(error instanceof FeishuApiError) ||
          error.kind === 'network' ||
          error.kind === 'rate_limited' ||
          error.kind === 'credential_rejected'
        )
          throw error
        this.options.log(`飞书回复失败（${error.message}），改为直接发送`)
      }
    }
    return await api.data('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: record.target.kind === 'chat' ? 'chat_id' : 'open_id' },
      body: { receive_id: record.target.id, ...body },
    })
  }

  /** 原样发冻结的原始请求；返回响应里的 data（发消息类是消息本身） */
  private async forwardRaw(
    api: import('./api.mjs').FeishuApi,
    folder: string,
    raw: NonNullable<SpeechPart['raw']>,
  ): Promise<Record<string, unknown> | null> {
    const body = readFileSync(join(folder, raw.file))
    const reply = await api.forward(
      raw.method,
      raw.pathAndQuery,
      raw.contentType ? { 'content-type': raw.contentType } : {},
      body,
    )
    if (reply.status === 429) throw new FeishuApiError('rate_limited', { status: 429 })
    if (!reply.json) {
      await reply.stream?.cancel()
      throw new FeishuApiError(reply.status >= 500 ? 'network' : 'platform', {
        status: reply.status,
      })
    }
    const { code, data } = reply.json
    if (code !== 0)
      throw new FeishuApiError(
        code === undefined && reply.status >= 500 ? 'network' : 'platform',
        { ...(code === undefined ? {} : { code }), status: reply.status },
      )
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null
  }

  private async upload(
    api: import('./api.mjs').FeishuApi,
    folder: string,
    upload: NonNullable<SpeechPart['upload']>,
  ): Promise<string> {
    const bytes = readFileSync(join(folder, upload.file))
    const form = new FormData()
    const blob = new Blob([bytes])
    if (upload.kind === 'image') {
      form.set('image_type', 'message')
      form.set('image', blob, upload.name)
    } else {
      form.set('file_type', 'stream')
      form.set('file_name', upload.name)
      form.set('file', blob, upload.name)
    }
    const data = await api.data<Record<string, unknown>>(
      'POST',
      upload.kind === 'image' ? '/open-apis/im/v1/images' : '/open-apis/im/v1/files',
      { form, timeoutMs: 120_000 },
    )
    const key = upload.kind === 'image' ? data.image_key : data.file_key
    if (typeof key !== 'string' || !key) throw new FeishuApiError('platform')
    return key
  }
}
