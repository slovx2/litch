// 叫醒经理（D-161、D-166）：收件箱按经理攒批，合成一组投递进经理的回合。
// - 攒批：一批里第一条到达后，等到“最后一条之后 20 秒”或“第一条之后 60 秒”先到的那个。
// - 同一经理同时只有一组在途；经理忙、等人答、被用户停下、重置中都留队（复用外部投递的准入）。
// - 限额：每个应用每 15 分钟最多 10 次自动叫醒，超了顺延，收件箱标“限额中”。
// - 内容：每个相关群“上次给过之后”的新消息，每群最多 50 条，找经理的那几条标出来；
//   接入时补进来的历史（早于接入时间）不算新消息，只在查历史时看得到（D-165）。
import { randomUUID } from 'node:crypto'
import type { FeishuInboxEntry } from '../../../protocol/src/feishu.mjs'
import type { Manager } from '../../../protocol/src/manager.mjs'
import { formatSessionEvent } from '../../../protocol/src/session-tree.mjs'
import type { FeishuChats } from './chats.mjs'
import { escapeExternal, FEISHU_DATA_NOTE, messageLine } from './format.mjs'
import type { FeishuInbox } from './inbox.mjs'
import type { ImMessages } from './messages.mjs'
import type { FeishuStore } from './store.mjs'

const QUIET = 20
const MAX_WAIT = 60
const RATE_WINDOW = 900
const RATE_LIMIT = 10
const PER_CHAT = 50

export interface Prepared {
  text: string
  eventId: string
}

export type FeishuSendResult =
  | { outcome: 'confirmed'; turnId: string }
  | { outcome: 'not_sent' | 'unknown' }

export interface FeishuWakeHost {
  manager(managerId: string): Manager | null
  /** 现在能不能投：经理空闲可投、没在重置、没被用户停下等（同外部投递） */
  canDeliver(manager: Manager): boolean
  /** 经理会话里装没装飞书工具；没装时投递里提示经理重置以装上 */
  toolsInstalled(manager: Manager): boolean
  /** 引擎发出前同步调用 beforeSend，返回 false 则取消 */
  send(input: {
    manager: Manager
    prepare(): Prepared | null
    beforeSend(prepared: Prepared): boolean
  }): Promise<FeishuSendResult>
}

export interface FeishuWakeOptions {
  store: FeishuStore
  inbox: FeishuInbox
  messages: ImMessages
  chats: FeishuChats
  /** 秒 */
  now: () => number
  log: (message: string) => void
  changed: (managerId: string, appId: string) => void
  /** 测试：检查间隔 */
  tickMs?: number
}

export class FeishuWake {
  private readonly options: FeishuWakeOptions
  host: FeishuWakeHost | null = null
  private readonly running = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private closed = false

  constructor(options: FeishuWakeOptions) {
    this.options = options
  }

  private get db() {
    return this.options.store.managers.db
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.options.tickMs ?? 2000).unref()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 新条目进来、经理空下来时调一次 */
  tick(): void {
    if (this.closed || !this.host) return
    for (const managerId of this.options.inbox.queuedManagers()) {
      if (this.running.has(managerId)) continue
      this.running.add(managerId)
      void this.attempt(managerId)
        .catch((error: Error) => this.options.log(`飞书叫醒经理出错：${error.message}`))
        .finally(() => this.running.delete(managerId))
    }
  }

  private queued(managerId: string, appId: string): FeishuInboxEntry[] {
    return this.options.inbox
      .list(managerId, ['queued'], 200)
      .filter((entry) => entry.appId === appId)
      .reverse()
  }

  /** 最近 15 分钟的叫醒次数；超限时返回最早可以再叫的时间 */
  private rateLimitedUntil(appId: string, now: number): number | null {
    const rows = this.db
      .prepare('SELECT at FROM feishu_deliveries WHERE app_id=? AND at>? ORDER BY at')
      .all(appId, now - RATE_WINDOW)
      .map((row) => Number(row.at))
    if (rows.length < RATE_LIMIT) return null
    return (rows[rows.length - RATE_LIMIT] ?? now) + RATE_WINDOW
  }

  private async attempt(managerId: string): Promise<void> {
    const host = this.host
    const { store, inbox, now } = this.options
    const app = store.appForManager(managerId)
    if (!host || !app?.enabled) return
    const entries = this.queued(managerId, app.appId)
    if (entries.length === 0) return
    const at = now()
    const first = Math.min(...entries.map((entry) => entry.receivedAt))
    const last = Math.max(...entries.map((entry) => entry.receivedAt))
    if (at < Math.min(last + QUIET, first + MAX_WAIT)) return
    if (this.rateLimitedUntil(app.appId, at) !== null) {
      const fresh = entries.filter((entry) => entry.note !== 'rate_limited')
      if (fresh.length > 0) {
        inbox.transition(
          managerId,
          fresh.map((entry) => entry.inboxId),
          ['queued'],
          'queued',
          { note: 'rate_limited' },
        )
        this.options.changed(managerId, app.appId)
      }
      return
    }
    const manager = host.manager(managerId)
    if (!manager || manager.status !== 'active' || !host.canDeliver(manager)) return
    const deliveryId = randomUUID()
    const eventId = `feishu-${deliveryId}`
    const tools = host.toolsInstalled(manager)
    let submitted: { inboxIds: string[]; cursors: Map<string, number> } | null = null
    const compose = () => {
      const current = this.queued(managerId, app.appId)
      return current.length > 0 ? this.compose(manager, app.appId, current, tools) : null
    }
    const result = await host
      .send({
        manager,
        prepare: () => {
          const plan = compose()
          return plan ? { text: plan.text, eventId } : null
        },
        beforeSend: (prepared) =>
          store.transaction(() => {
            if (submitted) return false
            const plan = compose()
            if (!plan || plan.text !== prepared.text || prepared.eventId !== eventId) return false
            const sentAt = now()
            const inboxIds = plan.entries.map((entry) => entry.inboxId)
            inbox.transition(managerId, inboxIds, ['queued'], 'notified', {
              deliveryId,
              notifiedAt: sentAt,
              note: undefined,
            })
            const previous = new Map<string, number>()
            for (const [chatId, seq] of plan.cursors) {
              previous.set(chatId, inbox.cursor(managerId, app.appId, chatId))
              inbox.advance(managerId, app.appId, chatId, seq)
            }
            this.db
              .prepare('INSERT INTO feishu_deliveries VALUES(?,?,?,?,?)')
              .run(
                deliveryId,
                managerId,
                app.appId,
                sentAt,
                JSON.stringify({ state: 'sending', inboxIds, threadId: manager.threadId }),
              )
            submitted = { inboxIds, cursors: previous }
            return true
          }),
      })
      .catch((): FeishuSendResult => ({ outcome: 'unknown' }))
    const sent = submitted as { inboxIds: string[]; cursors: Map<string, number> } | null
    if (!sent) return
    const body = (state: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ state, inboxIds: sent.inboxIds, threadId: manager.threadId, ...extra })
    if (result.outcome === 'confirmed')
      this.db
        .prepare('UPDATE feishu_deliveries SET body=? WHERE delivery_id=?')
        .run(body('confirmed', { turnId: result.turnId }), deliveryId)
    else if (result.outcome === 'not_sent') {
      // 引擎明确没收：条目退回排队、游标退回，不占额度
      store.transaction(() => {
        for (const [chatId, seq] of sent.cursors)
          inbox.resetCursor(managerId, app.appId, chatId, seq)
        inbox.transition(managerId, sent.inboxIds, ['notified'], 'queued', {
          deliveryId: undefined,
          notifiedAt: undefined,
        })
        this.db.prepare('DELETE FROM feishu_deliveries WHERE delivery_id=?').run(deliveryId)
      })
    } else
      this.db
        .prepare('UPDATE feishu_deliveries SET body=? WHERE delivery_id=?')
        .run(body('unknown'), deliveryId)
    this.options.changed(managerId, app.appId)
  }

  /** 最近一次送进回合的那一批（feishu_inbox_done 缺省标记它）；at 是秒 */
  lastDelivered(managerId: string): { inboxIds: string[]; at: number } | null {
    const row = this.db
      .prepare(
        'SELECT at, body FROM feishu_deliveries WHERE manager_id=? ORDER BY at DESC, rowid DESC LIMIT 1',
      )
      .get(managerId)
    if (!row) return null
    const body = JSON.parse(String(row.body)) as { inboxIds?: string[] }
    return { inboxIds: body.inboxIds ?? [], at: Number(row.at) }
  }

  /** 拼投递：给模型的全文、界面上的一行摘要、每群推进到的游标 */
  private compose(
    manager: Manager,
    appId: string,
    entries: FeishuInboxEntry[],
    tools: boolean,
  ): { text: string; entries: FeishuInboxEntry[]; cursors: Map<string, number> } {
    const { messages, chats, inbox, store } = this.options
    const app = store.app(appId)
    const byChat = new Map<string, FeishuInboxEntry[]>()
    for (const entry of entries)
      byChat.set(entry.chatId, [...(byChat.get(entry.chatId) ?? []), entry])
    const sections: string[] = []
    const summary: string[] = []
    const cursors = new Map<string, number>()
    for (const [chatId, found] of byChat) {
      const chat = chats.record(appId, chatId)
      const name = chat?.name || chatId
      const after = inbox.cursor(manager.id, appId, chatId)
      const since = (chat?.access?.accessAt ?? 0) * 1000
      const window = messages.since(appId, chatId, after, since, PER_CHAT)
      const shown = new Map(window.messages.map((message) => [message.messageId, message]))
      // 找经理的那几条一定带上，哪怕不在最近 50 条里
      for (const entry of found)
        if (!shown.has(entry.messageId)) {
          const message = messages.get(appId, entry.messageId)
          if (message) shown.set(message.messageId, message)
        }
      const marks = new Map(found.map((entry) => [entry.messageId, entry]))
      const ordered = [...shown.values()].sort((a, b) => a.seq - b.seq)
      const lines = ordered.map((message) => {
        const mark = marks.get(message.messageId)
        const flag = mark
          ? ` [${mark.inboxId} · ${mark.trigger === 'mention' ? 'mentioned the bot' : 'replied to the bot'} · sender ${mark.senderIdentity}]`
          : ''
        return messageLine(messages, appId, message, flag)
      })
      const omitted = window.total - window.messages.length
      sections.push(
        [
          `## ${escapeExternal(name)} (${chatId})${chat?.external ? ' · external chat: includes people outside the organization' : ''}`,
          ...(omitted > 0
            ? [`(${omitted} earlier new messages omitted; read them with feishu_history.)`]
            : []),
          ...lines,
        ].join('\n'),
      )
      summary.push(`${name} ${found.length}`)
      const top = Math.max(after, ...ordered.map((message) => message.seq))
      cursors.set(chatId, top)
    }
    const ids = entries.map((entry) => entry.inboxId).join(', ')
    const modelText = [
      '<litch-external-data source="feishu">',
      `Feishu app ${escapeExternal(app?.name ?? appId)} (${appId}). New messages in accessed chats since you were last given context. Entries marked [FI-n] asked for you. ${FEISHU_DATA_NOTE}`,
      ...sections,
      '</litch-external-data>',
      `Inbox entries: ${ids}. Handle what is needed; do not reply only to acknowledge. Open a board item when follow-up work is needed. When done, mark them with litch_feishu.feishu_inbox_done.`,
      ...(tools
        ? []
        : [
            'The litch_feishu tools are not installed in this manager session yet; ask the user to refresh or reset this manager to install them.',
          ]),
    ].join('\n')
    const text = formatSessionEvent(
      {
        kind: 'manager-feishu',
        notes: [],
        manager: { managerId: manager.id, text: `Feishu · ${summary.join(' · ')}` },
      },
      modelText,
    )
    return { text, entries, cursors }
  }
}
