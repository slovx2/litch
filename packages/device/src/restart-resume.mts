import { restartMessage } from '../../protocol/src/system-messages.mjs'
import type { EngineLink } from './engine-link.mjs'
import type { RestartStore, RestartTurn } from './restart-store.mjs'
import { sessionHistory } from './session-history.mjs'
import { isObject } from './wire.mjs'

const TTL = 24 * 60 * 60 * 1000
const REQUEST_MS = 5000
// 冷启动的原生会话可能需要读取较大的历史；此时尚未发送继续消息，不能用工具调用级的短时限放弃恢复。
const RESTORE_HISTORY_MS = 60_000
const PREPARE_CONCURRENCY = 4
const RESTORE_BACKOFF = [100, 500, 1500]

interface Sending {
  link: EngineLink
  threadId: string
  turnId: string | null
  stopped: boolean
  interruption: Promise<void> | null
}

export interface RestartHost {
  store: RestartStore
  service(): string
  open(harness: string): Promise<EngineLink>
  excluded(threadId: string): boolean
  background?(threadId: string): string[]
  resumed?(harness: string, threadId: string): void
  settled?(): void
  event?(harness: string, method: string, params: Record<string, unknown>): void
  log(line: string): void
  now?(): number
}

/** 只消费明确重启前准备的票；普通启动、断线、进程崩溃不从历史猜恢复意图。 */
export class RestartResume {
  private readonly host: RestartHost
  private readonly scopes = new Set<string>()
  private readonly restoring = new Set<string>()
  private readonly links = new Set<EngineLink>()
  private readonly waitingEpoch = new Map<string, number>()
  private readonly sending = new Map<string, Sending>()
  private closed = false
  private recovery: Promise<void> = Promise.resolve()

  constructor(host: RestartHost) {
    this.host = host
  }

  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  private move(row: RestartTurn, from: string, to: string): boolean {
    return !this.closed && this.host.store.move(row, from, to)
  }

  interrupting(threadId: string, turnId: string): boolean {
    return this.host.store.interrupting(threadId, turnId)
  }

  pending(threadId: string): boolean {
    return this.restoring.has(threadId) || this.host.store.pending(threadId)
  }

  blocked(harness: string, threadId?: string): boolean {
    return (
      this.scopes.has('*') ||
      this.scopes.has(harness) ||
      (threadId !== undefined && this.pending(threadId))
    )
  }

  cancel(threadId: string, stopRunning = true): void {
    if (!this.closed) this.host.store.cancel(threadId)
    const sending = this.sending.get(threadId)
    if (sending && stopRunning) {
      sending.stopped = true
      void this.interruptSending(sending)
    }
  }

  /** 用户停的是重启前的回合号时，也要停止刚派发、可能尚未回显的自动恢复回合。 */
  private interruptSending(sending: Sending): Promise<void> {
    if (this.closed || !sending.stopped || sending.turnId === null) return Promise.resolve()
    if (sending.interruption) return sending.interruption
    sending.interruption = sending.link
      .request(
        'turn/interrupt',
        {
          threadId: sending.threadId,
          turnId: sending.turnId,
        },
        { timeoutMs: REQUEST_MS },
      )
      .then(
        () => {},
        (error) => this.host.log(`恢复回合的停止未确认: ${String(error)}`),
      )
    return sending.interruption
  }

  stop(): void {
    this.scopes.add('*')
    for (const state of ['observed', 'finished', 'preparing', 'ready'])
      for (const row of this.host.store.rows(state)) this.cancel(row.threadId)
  }

  input(harness: string, threadId: string): string {
    this.cancel(threadId, false)
    if (this.blocked(harness, threadId)) throw new Error('设备正在重启或恢复此会话，请稍后发送')
    return this.host.store.input(harness, threadId)
  }

  accepted(threadId: string, token: string, result: unknown): void {
    if (this.closed) return
    if (isObject(result) && isObject(result.turn) && typeof result.turn.id === 'string')
      this.host.store.accepted(threadId, token, result.turn.id)
  }

  /** 待答与后续自动回合不能借旧的人类输入取得恢复资格。准备时的自身中断不清票。 */
  observe(method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    if (typeof params.threadId !== 'string') return
    if (method === 'turn/completed' && isObject(params.turn) && typeof params.turn.id === 'string')
      this.host.store.finished(params.threadId, params.turn.id)
    if (
      method.includes('requestApproval') ||
      method.includes('requestUserInput') ||
      method.includes('elicitation')
    ) {
      this.waitingEpoch.set(params.threadId, (this.waitingEpoch.get(params.threadId) ?? 0) + 1)
      this.host.store.waiting(params.threadId)
    }
    if (method === 'thread/archived' || method === 'thread/deleted') this.cancel(params.threadId)
  }

  private async open(harness: string): Promise<EngineLink> {
    const link = await this.host.open(harness)
    if (this.closed) {
      link.close()
      throw new Error('设备正在关闭')
    }
    this.links.add(link)
    link.onClose(() => {
      this.links.delete(link)
      for (const [id, sending] of this.sending) if (sending.link === link) this.sending.delete(id)
    })
    link.onServerRequest((method, params) => {
      if (isObject(params)) this.observe(method, params)
    })
    return link
  }

  private async read(link: EngineLink, row: RestartTurn, timeoutMs = REQUEST_MS): Promise<any> {
    return { thread: await sessionHistory(link, row.threadId, true, 1, timeoutMs) }
  }

  private eligible(row: RestartTurn, thread: any): boolean {
    if (
      this.closed ||
      this.host.excluded(row.threadId) ||
      !thread ||
      thread.archived ||
      thread.ephemeral ||
      thread.litchNativeLineage ||
      (isObject(thread.source) && 'subAgent' in thread.source)
    )
      return false
    const flags = thread.status?.activeFlags
    return !(
      Array.isArray(flags) &&
      flags.some((flag: unknown) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')
    )
  }

  /** resume 有启动目标／队列的副作用，必须先只读排除，问不清也不能自动发。 */
  private async autonomous(link: EngineLink, row: RestartTurn): Promise<boolean> {
    const features = isObject(link.runtime?.features) ? link.runtime.features : {}
    if (features.goals === true) {
      const result = await link.request(
        'thread/goal/get',
        { threadId: row.threadId },
        { timeoutMs: REQUEST_MS },
      )
      if (result.goal && !['complete', 'cleared'].includes(result.goal.status)) return true
    }
    if (features.queue === true) {
      const result = await link.request(
        'thread/queue/list',
        { threadId: row.threadId },
        { timeoutMs: REQUEST_MS },
      )
      if (!Array.isArray(result.data)) return true
      if (result.data.length > 0) return true
    }
    return false
  }

  async prepare(harness?: string): Promise<{ prepared: number }> {
    const scope = harness ?? '*'
    if (
      this.closed ||
      this.scopes.has('*') ||
      this.scopes.has(scope) ||
      (!harness && this.scopes.size > 0)
    )
      throw new Error('重启准备已在进行')
    this.scopes.add(scope)
    // finished 仍保留原工作 token：后台任务不凭空变成新的用户授权，也不重置一次恢复预算。
    const rows = [...this.host.store.rows('observed'), ...this.host.store.rows('finished')]
      .filter((row) => !harness || row.harness === harness)
      .filter((row) => row.state === 'observed' || this.host.background?.(row.threadId).length)
    let prepared = 0
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(PREPARE_CONCURRENCY, rows.length) }, async () => {
        while (next < rows.length && !this.closed) {
          const row = rows[next++]
          if (row && (await this.prepareTurn(row))) prepared++
        }
      }),
    )
    this.host.log(`计划重启准备（${scope}）：观察 ${rows.length}，可恢复 ${prepared}`)
    return { prepared }
  }

  private async prepareTurn(row: RestartTurn): Promise<boolean> {
    if (!row.turnId || this.host.excluded(row.threadId)) return false
    const waitingEpoch = this.waitingEpoch.get(row.threadId) ?? 0
    let link: EngineLink | null = null
    try {
      link = await this.open(row.harness)
      const before = (await this.read(link, row)).thread
      const last = before?.turns?.at(-1)
      const background = this.host.background?.(row.threadId) ?? []
      const idleBackground = last?.status === 'completed' && background.length > 0
      if (
        !this.eligible(row, before) ||
        !last?.id ||
        (last.id !== row.turnId && last.litchOrigin !== 'backgroundTask') ||
        (!idleBackground && last.status !== 'inProgress') ||
        (last.litchOrigin && !['user', 'backgroundTask'].includes(last.litchOrigin)) ||
        (await this.autonomous(link, row))
      )
        return false
      if (
        (this.waitingEpoch.get(row.threadId) ?? 0) !== waitingEpoch ||
        this.host.excluded(row.threadId)
      )
        return false
      if (!this.host.store.prepare(row, this.host.service(), this.now(), background, last.id))
        return false
      row.turnId = last.id
      // 前台早已完成，只持久化后台工作清单；不对已结束回合发送 interrupt。
      if (idleBackground) return this.move(row, 'preparing', 'ready')
      // 先明确结束旧回合，避免“快照后正常完成”也被重新续一次。未知工具结果由恢复消息提醒核实。
      await link.request(
        'turn/interrupt',
        { threadId: row.threadId, turnId: row.turnId },
        { timeoutMs: REQUEST_MS },
      )
      let stopped = (await this.read(link, row)).thread
      const deadline = Date.now() + 5000
      while (
        stopped?.turns?.at(-1)?.id === row.turnId &&
        stopped.turns.at(-1).status === 'inProgress' &&
        Date.now() < deadline &&
        !this.closed &&
        this.host.store.state(row) === 'preparing'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        stopped = (await this.read(link, row)).thread
      }
      const turn = stopped?.turns?.at(-1)
      if (
        !this.eligible(row, stopped) ||
        turn?.id !== row.turnId ||
        turn.status !== 'interrupted'
      ) {
        this.move(row, 'preparing', 'skipped')
        return false
      }
      return this.move(row, 'preparing', 'ready')
    } catch (error) {
      if (!this.closed) this.move(row, 'preparing', 'skipped')
      this.host.log(`重启恢复准备未完成 (${row.harness}/${row.threadId}): ${String(error)}`)
      return false
    } finally {
      if (link) {
        this.links.delete(link)
        link.close()
      }
    }
  }

  /** 单引擎 apply 已由 Go 确认换代；完整服务只在 service 身份变化后消费。 */
  recover(harness?: string): Promise<void> {
    // 设置可同时重启多个引擎；串行消费，不能因另一份恢复正在执行而丢掉本次 apply 的确认。
    const work = this.recovery.then(async () => {
      if (this.closed || !this.host.service()) return
      for (const row of this.host.store.rows('ready')) {
        if (this.closed) break
        if (harness ? row.harness !== harness : row.service === this.host.service()) continue
        await this.recoverTurn(row)
      }
    })
    this.recovery = work.catch((error) => this.host.log(`重启恢复未完成: ${String(error)}`))
    return this.recovery
  }

  private async recoverTurn(row: RestartTurn): Promise<void> {
    let link: EngineLink | null = null
    let sending: Sending | null = null
    if (
      row.preparedAt === null ||
      this.now() - row.preparedAt > TTL ||
      this.now() < row.preparedAt
    ) {
      this.move(row, 'ready', 'skipped')
      return
    }
    this.restoring.add(row.threadId)
    try {
      if (this.host.excluded(row.threadId)) {
        this.move(row, 'ready', 'skipped')
        return
      }
      // 仅对发送之前的连接和只读探测退避；resume/start 有副作用，绝不因此重放。
      let thread: any
      for (let attempt = 0; ; attempt++) {
        try {
          link = await this.open(row.harness)
          thread = (await this.read(link, row, RESTORE_HISTORY_MS)).thread
          break
        } catch (error) {
          if (link) {
            this.links.delete(link)
            link.close()
            link = null
          }
          const delay = RESTORE_BACKOFF[attempt]
          if (delay === undefined || this.closed || this.host.store.state(row) !== 'ready')
            throw error
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
      if (
        !this.eligible(row, thread) ||
        thread.turns?.at(-1)?.id !== row.turnId ||
        thread.turns?.at(-1)?.status === 'inProgress' ||
        (await this.autonomous(link, row))
      ) {
        this.move(row, 'ready', 'skipped')
        return
      }
      if (this.host.store.state(row) !== 'ready') return
      await link.request(
        'thread/resume',
        { threadId: row.threadId, excludeTurns: true },
        { timeoutMs: RESTORE_HISTORY_MS },
      )
      // 各引擎的 resume 应答不一定包含回合历史，统一用 read 再核对。
      thread = (await this.read(link, row, RESTORE_HISTORY_MS)).thread
      if (
        !this.eligible(row, thread) ||
        thread.turns?.at(-1)?.id !== row.turnId ||
        thread.turns?.at(-1)?.status === 'inProgress'
      ) {
        this.move(row, 'ready', 'skipped')
        return
      }
      const watching = link
      sending = { link, threadId: row.threadId, turnId: null, stopped: false, interruption: null }
      const sent = sending
      this.sending.set(row.threadId, sent)
      const ended = new Set<string>()
      let sentTurn: string | null = null
      watching.onNotification((method, params) => {
        if (isObject(params)) this.host.event?.(row.harness, method, params)
        if (method !== 'turn/completed' || typeof params?.turn?.id !== 'string') return
        ended.add(params.turn.id)
        if (params.turn.id === sentTurn) {
          if (this.sending.get(row.threadId) === sent) this.sending.delete(row.threadId)
          watching.close()
        }
      })
      // 先落 dispatching 再发；断连接／超时不重试。停止或新输入已经撤票时，此处原子检查失败。
      const result = await link.request(
        'turn/start',
        {
          threadId: row.threadId,
          input: [{ type: 'text', text: restartMessage(row.token, row.background) }],
        },
        {
          timeoutMs: REQUEST_MS,
          beforeSend: () => {
            if (
              this.closed ||
              this.host.excluded(row.threadId) ||
              !this.move(row, 'ready', 'dispatching')
            )
              throw new Error('恢复已被停止或新的用户输入取消')
            this.host.resumed?.(row.harness, row.threadId)
          },
        },
      )
      if (typeof result?.turn?.id === 'string') {
        sentTurn = result.turn.id
        sent.turnId = result.turn.id
        if (!this.closed) {
          this.host.store.sent(row, result.turn.id)
          this.host.log(`重启恢复已发送（${row.harness}/${row.threadId}）：${result.turn.id}`)
        }
        await this.interruptSending(sent)
      }
      // 保持设备连接观察恢复回合，避免没有客户端在线时设备工具和审批失去执行方。
      if (sentTurn === null || ended.has(sentTurn)) {
        if (this.sending.get(row.threadId) === sent) this.sending.delete(row.threadId)
        watching.close()
      }
      link = null
    } catch (error) {
      if (!this.closed) this.move(row, 'ready', 'skipped')
      // 仅核对自己的机器消息后补停；发送应答丢失绝不重发，也不能误停另一条新的人类回合。
      if (!this.closed && sending?.stopped) {
        try {
          if (!link || link.closed) link = await this.open(row.harness)
          const current = (await this.read(link, row)).thread?.turns?.at(-1)
          const own = current?.items?.some(
            (item: any) =>
              item.type === 'userMessage' &&
              item.content?.some(
                (part: any) =>
                  part.type === 'text' && part.text === restartMessage(row.token, row.background),
              ),
          )
          if (own && current.status === 'inProgress') {
            sending.link = link
            sending.turnId = current.id
            await this.interruptSending(sending)
          }
        } catch (failure) {
          this.host.log(`未能核实待停止的恢复回合: ${String(failure)}`)
        }
      }
      this.host.log(`重启恢复未确认，不自动重试 (${row.harness}/${row.threadId}): ${String(error)}`)
    } finally {
      this.restoring.delete(row.threadId)
      this.host.settled?.()
      if (link) {
        if (sending && this.sending.get(row.threadId) === sending) this.sending.delete(row.threadId)
        this.links.delete(link)
        link.close()
      }
    }
  }

  release(harness?: string): void {
    this.scopes.delete(harness ?? '*')
    this.host.settled?.()
  }

  close(): void {
    this.closed = true
    for (const link of this.links) link.close()
    this.links.clear()
    this.sending.clear()
  }
}
