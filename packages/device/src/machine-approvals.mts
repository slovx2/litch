import type { DatabaseSync } from 'node:sqlite'
import type { LitchBackgroundTask } from '../../protocol/src/background-tasks.mjs'
import {
  isMachineApprovalId,
  MACHINE_APPROVAL_METHOD as M,
  MACHINE_APPROVAL_MAX_PER_EXECUTOR,
  MACHINE_APPROVAL_MAX_TEXT,
  MACHINE_APPROVAL_TTL_MS,
  MACHINE_APPROVALS,
  MACHINE_TASK_PREFIX,
  type MachineApprovalCard,
  type MachineApprovalOutcome,
  MACHINE_APPROVAL_NOTIFICATION as N,
} from '../../protocol/src/machine-approvals.mjs'
import {
  formatBackgroundCompletion,
  parseBackgroundCompletion,
} from '../../protocol/src/native-background-wake.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ClientToolPeer } from './client-tools.mjs'
import { isObject } from './wire.mjs'

type Peer = ClientToolPeer & {
  declares(extension: string): boolean
  announce(method: string, params: unknown, extension?: string): void
}

interface Entry {
  peer: Peer
  card: MachineApprovalCard
  callId: string
  timer: NodeJS.Timeout
  startedAt: number | null
  stopAsked: boolean
}

interface Host {
  db: DatabaseSync
  source(peer: ClientToolPeer, threadId: string, callId: string): boolean
  allowed(threadId: string): boolean
  announce(method: string, params: unknown, extension: string): void
  task(threadId: string, task: LitchBackgroundTask): void
  deliver(threadId: string, text: string, id: string, onDispatch: () => void): Promise<boolean>
  log(message: string): void
}

const invalid = (message: string): never => {
  throw new ProtocolError(-32602, message)
}

export class DeviceMachineApprovals {
  private readonly entries = new Map<string, Entry>()
  private timer: NodeJS.Timeout | null = null
  private closed = false
  private pumping = false

  private readonly host: Host

  constructor(host: Host) {
    this.host = host
    host.db.exec(`CREATE TABLE IF NOT EXISTS machine_approval_results (
      id TEXT PRIMARY KEY, thread TEXT NOT NULL, body TEXT NOT NULL,
      created INTEGER NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0
    )`)
  }

  call(peer: Peer, admin: boolean, method: string, input: unknown): unknown {
    if (!peer.declares(MACHINE_APPROVALS) || !admin)
      throw new ProtocolError(
        -32601,
        'Machine approvals require a declared administrator connection',
      )
    if (method === M.list) return { cards: this.cards() }
    const data = isObject(input) ? input : {}
    if (!isMachineApprovalId(data.id) || typeof data.threadId !== 'string')
      return invalid('Invalid machine approval identifier')
    if (method === M.open) return this.open(peer, data)
    const entry = this.entries.get(data.id)
    if (entry?.card.threadId !== data.threadId) return invalid('Machine approval is no longer open')
    if (method === M.stop) {
      if (entry.startedAt === null) return invalid('Machine approval has not started')
      if (!entry.stopAsked) {
        entry.stopAsked = true
        entry.peer.announce(
          N.stop,
          { id: entry.card.id, threadId: entry.card.threadId },
          MACHINE_APPROVALS,
        )
      }
      return {}
    }
    if (entry.peer !== peer) return invalid('Only the selected desktop can resolve this request')
    if (method === M.start) {
      if (
        entry.startedAt !== null ||
        entry.card.expiresAt <= Date.now() ||
        !this.host.allowed(entry.card.threadId)
      )
        return invalid('Machine approval can no longer be started')
      clearTimeout(entry.timer)
      entry.startedAt = Date.now()
      entry.timer = setTimeout(() => this.end(entry, 'lost'), 120_000).unref()
      this.changed(entry.card.threadId)
      this.host.task(entry.card.threadId, this.task(entry, 'running'))
      return {}
    }
    if (method === M.finish) {
      const outcome = data.outcome
      if (entry.startedAt === null) {
        if (outcome !== 'rejected' && outcome !== 'expired' && outcome !== 'lost')
          return invalid('Machine approval has not started')
      } else if (
        outcome !== 'completed' &&
        outcome !== 'failed' &&
        outcome !== 'stopped' &&
        outcome !== 'lost'
      )
        return invalid('Invalid machine operation outcome')
      this.end(entry, outcome, typeof data.text === 'string' ? data.text : '')
      return {}
    }
    throw new ProtocolError(-32601, 'Unknown machine approval method')
  }

  private open(peer: Peer, data: Record<string, unknown>): object {
    const { id, threadId, turnId, action, target, cwd, desktop, expiresAt, callId } = data
    const now = Date.now()
    if (
      !isMachineApprovalId(id) ||
      typeof threadId !== 'string' ||
      !(turnId === null || typeof turnId === 'string') ||
      (action !== 'exec' && action !== 'read' && action !== 'write' && action !== 'list') ||
      typeof target !== 'string' ||
      !target ||
      target.length > 4096 ||
      !(cwd === null || (typeof cwd === 'string' && cwd.length <= 4096)) ||
      typeof desktop !== 'string' ||
      desktop.length > 200 ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + MACHINE_APPROVAL_TTL_MS ||
      typeof callId !== 'string' ||
      !this.host.source(peer, threadId, callId) ||
      !this.host.allowed(threadId)
    )
      return invalid('Invalid or unauthorized machine approval')
    if (this.entries.has(id)) return invalid('Duplicate machine approval')
    const owned = [...this.entries.values()].filter((entry) => entry.peer === peer)
    if (
      owned.length >= MACHINE_APPROVAL_MAX_PER_EXECUTOR ||
      owned.some((entry) => entry.callId === callId && entry.card.threadId === threadId)
    )
      return invalid('Too many or duplicate machine approvals')
    const card: MachineApprovalCard = {
      id,
      threadId,
      turnId,
      action,
      target,
      cwd,
      desktop,
      expiresAt,
    }
    const timer = setTimeout(() => {
      const entry = this.entries.get(id)
      if (entry) this.end(entry, 'expired')
    }, expiresAt - now).unref()
    this.entries.set(id, { peer, card, callId, startedAt: null, stopAsked: false, timer })
    this.changed(threadId)
    return {}
  }

  private cards(threadId?: string): MachineApprovalCard[] {
    return [...this.entries.values()].flatMap(({ card, startedAt }) =>
      startedAt === null && (threadId === undefined || threadId === card.threadId) ? [card] : [],
    )
  }

  private changed(threadId: string): void {
    this.host.announce(N.changed, { threadId, cards: this.cards(threadId) }, MACHINE_APPROVALS)
  }

  private task(entry: Entry, status: LitchBackgroundTask['status']): LitchBackgroundTask {
    return {
      id: MACHINE_TASK_PREFIX + entry.card.id,
      kind: 'remote',
      title: entry.card.target.slice(0, 160),
      status,
      ...(entry.card.turnId ? { turnId: entry.card.turnId } : {}),
      ...(entry.startedAt === null ? {} : { startedAt: entry.startedAt }),
      ...(status === 'running' ? {} : { endedAt: Date.now() }),
    }
  }

  private end(entry: Entry, outcome: MachineApprovalOutcome, text = ''): void {
    const { id, threadId, turnId } = entry.card
    if (!this.entries.delete(id)) return
    clearTimeout(entry.timer)
    if (entry.startedAt === null) this.changed(threadId)
    const task = this.task(
      entry,
      outcome === 'completed' ? 'completed' : outcome === 'stopped' ? 'stopped' : 'failed',
    )
    if (entry.startedAt !== null) this.host.task(threadId, task)
    const status = {
      completed: 'The approved operation finished.',
      failed: 'The approved operation failed.',
      stopped: 'The user stopped the approved operation.',
      rejected: 'The user declined the operation. Do not retry it.',
      expired: 'Approval expired. The operation was not run.',
      lost:
        entry.startedAt === null
          ? 'The selected desktop disconnected. The operation was not run.'
          : 'The selected desktop stopped reporting. The outcome is unknown; do not repeat the operation without checking.',
    }[outcome]
    const limit = Math.floor(MACHINE_APPROVAL_MAX_TEXT / 3)
    const body = formatBackgroundCompletion({
      batchId: task.id,
      events: [
        {
          taskId: task.id,
          originalTurnId: turnId ?? '',
          itemId: '',
          title: task.title,
          purpose: status,
          purposeTruncated: false,
          status: outcome === 'completed' ? 'completed' : 'failed',
          exitCode: null,
          signal: '',
          durationMs: entry.startedAt === null ? 0 : Date.now() - entry.startedAt,
          output: (text || status)
            .slice(0, limit)
            .replace(/\p{C}/gu, (character) =>
              character === '\n' || character === '\r' || character === '\t' ? character : ' ',
            ),
          outputMayBeTruncated: text.length > limit,
          truncated: text.length > limit,
        },
      ],
    })
    this.host.db
      .prepare(
        'INSERT OR IGNORE INTO machine_approval_results (id,thread,body,created) VALUES (?,?,?,?)',
      )
      .run(task.id, threadId, body, Date.now())
    this.schedule(0)
  }

  schedule(delay = 1500): void {
    if (
      this.closed ||
      this.timer ||
      this.pumping ||
      !this.host.db
        .prepare('SELECT 1 FROM machine_approval_results WHERE dispatched = 0 LIMIT 1')
        .get()
    )
      return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pump()
    }, delay).unref()
  }

  /** 将设备实际投递的那条恢复为后台结果卡，原样文本不能冒充新的用户批准。 */
  decorate(threadId: string, value: Record<string, unknown>, depth = 0): boolean {
    if (depth > 6) return false
    if (value.type === 'userMessage' && Array.isArray(value.content)) {
      const item = value.content[0]
      if (
        value.content.length !== 1 ||
        !isObject(item) ||
        item.type !== 'text' ||
        typeof item.text !== 'string'
      )
        return false
      const text = item.text
      if (!text.startsWith('<litch-background-completed>')) return false
      const batch = parseBackgroundCompletion(text)?.batchId
      if (!batch?.startsWith(MACHINE_TASK_PREFIX)) return false
      const row = this.host.db
        .prepare(
          'SELECT 1 FROM machine_approval_results WHERE id = ? AND thread = ? AND body = ? AND dispatched = 1',
        )
        .get(batch, threadId, text)
      if (!row) return false
      value.litchOrigin = 'backgroundTask'
      return true
    }
    let changed = false
    const scope =
      isObject(value.thread) && typeof value.thread.id === 'string'
        ? value.thread.id
        : Array.isArray(value.turns) && typeof value.id === 'string'
          ? value.id
          : threadId
    for (const key of ['item', 'thread', 'turn', 'initialTurnsPage']) {
      const child = value[key]
      if (isObject(child) && this.decorate(scope, child, depth + 1)) changed = true
    }
    for (const key of ['turns', 'items', 'data']) {
      const children = value[key]
      if (!Array.isArray(children)) continue
      for (const child of children)
        if (isObject(child) && this.decorate(scope, child, depth + 1)) {
          if (key === 'items' && typeof value.id === 'string') value.litchOrigin = 'backgroundTask'
          changed = true
        }
    }
    return changed
  }

  private async pump(): Promise<void> {
    this.pumping = true
    try {
      this.host.db
        .prepare('DELETE FROM machine_approval_results WHERE created < ?')
        .run(Date.now() - 7 * MACHINE_APPROVAL_TTL_MS)
      const rows = this.host.db
        .prepare(`SELECT id,thread,body FROM machine_approval_results
        WHERE dispatched = 0 ORDER BY created LIMIT 32`)
        .all()
      for (const row of rows) {
        if (this.closed) return
        const id = String(row.id)
        const dispatched = () =>
          this.host.db
            .prepare('UPDATE machine_approval_results SET dispatched = 1 WHERE id = ?')
            .run(id)
        try {
          // 提交到引擎前记下。发送后若应答丢失，不重复叫醒；尚未提交的仍保留。
          if (
            (await this.host.deliver(String(row.thread), String(row.body), id, dispatched)) &&
            !this.closed
          )
            dispatched()
        } catch (error) {
          this.host.log(`本机操作结果未确认送达：${id} ${String(error)}`)
        }
      }
    } finally {
      this.pumping = false
      this.schedule()
    }
  }

  left(peer: Peer): void {
    for (const entry of this.entries.values()) if (entry.peer === peer) this.end(entry, 'lost')
  }

  shutdown(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const entry of this.entries.values()) this.end(entry, 'lost')
  }
}
