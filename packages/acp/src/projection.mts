// 把 ACP 的 session/update 归并成 Codex 的回合与条目。实时（回合进行中）和回放（session/load）共用一套。
//
// ACP 的更新里没有回合：一次 session/prompt 从发出到应答是一个回合，由适配器建（begin）、按应答的
// stopReason 收尾（finish）。回放时没有 prompt，用户的话（user_message_chunk）开始一个新回合。
import {
  blockText,
  contentText,
  diffChanges,
  exitCodeOf,
  fileChangeOf,
  itemStatus,
  mcpResult,
  rawOutputText,
  terminalIds,
  toolItem,
} from './tools.mjs'

export interface AcpThread {
  id: string
  cwd: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  forkedFromId: string | null
  // 临时线程只存在于适配器内存里，没有对应的 agent 会话。
  ephemeral: boolean
}
export interface AcpTurn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}
export type Notify = (method: string, params: any) => void

/** 一次更新改了会话层面的什么：设置（模式、配置项）、命令清单、名字 */
export type SessionChange = 'settings' | 'commands' | 'name' | null

/** 回合怎么结束的：agent 应答的 stopReason，或者出错、被适配器收尾 */
export type TurnOutcome =
  | { stopReason: string; usage?: any }
  | { error: string }
  | { interrupted: true }

interface ToolState {
  item: any
  turn: AcpTurn
  startedMs: number
  declined: boolean
  /** 经 fs/write_text_file 写的、挂在这个调用上的改动（按路径） */
  writes: Map<string, any>
}

type Breakdown = {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}
const zero = (): Breakdown => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
})

export class Projection {
  readonly thread: AcpThread
  readonly turns: AcpTurn[] = []
  active: AcpTurn | null = null
  /** agent 报的模式、配置项、模型（会话层面的设置，见 envelope.mts 的 settings） */
  modes: { currentModeId: string; availableModes: any[] } | null = null
  configOptions: any[] | null = null
  models: { currentModelId: string; availableModels: any[] } | null = null
  /** agent 报的斜杠命令（available_commands_update） */
  commands: any[] = []
  /** 用户改过名字（thread/name/set）之后，agent 报的标题不再盖掉它 */
  userNamed = false
  /** 回放中：用户的话开始新回合，不发通知 */
  private replaying = false
  // 正在流的那一段话或思考：别的条目一来就收尾
  private current: { item: any; messageId: string | null } | null = null
  private counter = 0
  private readonly tools = new Map<string, ToolState>()
  private readonly startedMs = new Map<string, number>()
  // 正在等用户的审批，一件一个记号（见 waiting）
  private readonly approving = new Set<symbol>()
  contextWindow: number | null = null
  private readonly total = zero()
  private last: Breakdown | null = null
  /** 回放时按 agent 收到的那句话找客户端当初发来的样子（AcpServer.remember） */
  private readonly recorded: (text: string) => { content: any[]; clientId: string | null } | null

  constructor(
    thread: AcpThread,
    recorded: (text: string) => { content: any[]; clientId: string | null } | null = () => null,
  ) {
    this.thread = thread
    this.recorded = recorded
  }

  /** 线程现在的状态，照上游 thread_status.rs：有回合在跑或者有审批在等是 active */
  status(): any {
    const activeFlags = this.approving.size ? ['waitingOnApproval'] : []
    return this.active || activeFlags.length ? { type: 'active', activeFlags } : { type: 'idle' }
  }

  /** 等用户审批的这段时间（work）线程标着在等，等完改回来 */
  async waiting<T>(notify: Notify, work: () => Promise<T>): Promise<T> {
    const mark = Symbol('approval')
    this.approving.add(mark)
    notify('thread/status/changed', { status: this.status() })
    try {
      return await work()
    } finally {
      if (this.approving.delete(mark)) notify('thread/status/changed', { status: this.status() })
    }
  }

  tool(toolCallId: string): ToolState | undefined {
    return this.tools.get(toolCallId)
  }

  /** 开一个回合。实时的由适配器在发 prompt 之前开；回放的由用户的话开 */
  begin(notify: Notify, time = Date.now()): AcpTurn {
    if (this.active) this.finish({ interrupted: true }, notify, time)
    const turn: AcpTurn = {
      id: `turn:${this.turns.length + 1}`,
      items: [],
      status: 'inProgress',
      error: null,
      startedAt: Math.floor(time / 1000),
      completedAt: null,
      durationMs: null,
    }
    this.startedMs.set(turn.id, time)
    this.turns.push(turn)
    this.active = turn
    this.last = null
    notify('turn/started', { turn })
    notify('thread/status/changed', { status: this.status() })
    return turn
  }

  /** 回合里用户的那句话：content 是客户端发来的样子，preview 取其中的字 */
  userMessage(content: any[], clientId: string | null, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const text = content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n')
    if (!this.thread.preview) this.thread.preview = text.slice(0, 200)
    this.put(turn, { type: 'userMessage', id: `${turn.id}:user`, content, clientId }, true, notify)
  }

  private nextId(turn: AcpTurn, kind: string): string {
    return `${turn.id}:${kind}${++this.counter}`
  }

  private put(turn: AcpTurn, item: any, complete: boolean, notify: Notify): any {
    const index = turn.items.findIndex((entry) => entry.id === item.id)
    if (index < 0) {
      turn.items.push(item)
      notify('item/started', {
        turnId: turn.id,
        item:
          item.type === 'reasoning'
            ? { ...item, summary: [], content: [] }
            : item.type === 'agentMessage'
              ? { ...item, text: '' }
              : item,
      })
      if (item.type === 'reasoning')
        notify('item/reasoning/summaryPartAdded', {
          turnId: turn.id,
          itemId: item.id,
          summaryIndex: 0,
        })
    } else turn.items[index] = item
    if (complete) notify('item/completed', { turnId: turn.id, item })
    return item
  }

  // 收尾正在流的那一段。话后面还有别的（工具、思考）是过程说明，回合结束时还开着的是最终回答。
  private closeCurrent(notify: Notify, final: boolean): void {
    const current = this.current
    this.current = null
    const turn = this.active
    if (!current || !turn) return
    if (current.item.type === 'agentMessage')
      current.item.phase = final ? 'final_answer' : 'commentary'
    notify('item/completed', { turnId: turn.id, item: current.item })
  }

  private stream(kind: 'message' | 'thought', chunk: any, notify: Notify): void {
    const turn = this.active
    const text = blockText(chunk?.content)
    if (!turn || !text) return
    const messageId = typeof chunk.messageId === 'string' ? chunk.messageId : null
    const type = kind === 'message' ? 'agentMessage' : 'reasoning'
    const current = this.current
    const continues =
      current?.item.type === type &&
      (messageId === null || current.messageId === null || current.messageId === messageId)
    if (!continues) {
      this.closeCurrent(notify, false)
      const id = this.nextId(turn, kind === 'message' ? 'msg' : 'think')
      const item =
        type === 'agentMessage'
          ? { type, id, text: '', phase: 'final_answer', memoryCitation: null }
          : { type, id, summary: [''], content: [] }
      this.put(turn, item, false, notify)
      this.current = { item, messageId }
    }
    const item = (this.current as { item: any }).item
    if (type === 'agentMessage') {
      item.text += text
      notify('item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta: text })
    } else {
      item.summary[0] += text
      notify('item/reasoning/summaryTextDelta', {
        turnId: turn.id,
        itemId: item.id,
        summaryIndex: 0,
        delta: text,
      })
    }
  }

  // 回放时用户的话：上一回合 agent 已经答过了就收尾、另起一回合；话分几块来的接在一起
  private replayUser(chunk: any): void {
    const text = blockText(chunk?.content)
    const turn = this.active
    const last = turn?.items.at(-1)
    const quiet: Notify = () => {}
    if (turn && last?.type === 'userMessage' && turn.items.length === 1) {
      last.content[0].text += text
      return
    }
    if (turn) this.finish({ stopReason: 'end_turn' }, quiet, this.thread.updatedAt * 1000)
    this.begin(quiet, this.thread.updatedAt * 1000)
    this.userMessage([{ type: 'text', text, text_elements: [] }], null, quiet)
  }

  // 回放的用户消息定稿：照 agent 收到的那句话找客户端当初发来的样子
  private settleReplayedUser(turn: AcpTurn | null): void {
    const user = turn?.items[0]
    if (user?.type !== 'userMessage' || user.clientId !== null) return
    const recorded = this.recorded(String(user.content[0]?.text ?? ''))
    if (!recorded) return
    user.content = recorded.content
    user.clientId = recorded.clientId
  }

  /** 开始回放：之后的更新按历史来，不发通知，用户的话开新回合 */
  startReplay(): void {
    this.replaying = true
  }

  /** 回放完：最后一个回合收尾，用户消息换回客户端发来的样子，预览按头一句重算 */
  endReplay(): void {
    const quiet: Notify = () => {}
    if (this.active) this.finish({ stopReason: 'end_turn' }, quiet, this.thread.updatedAt * 1000)
    for (const turn of this.turns) {
      this.settleReplayedUser(turn)
      // 历史里没收尾的工具调用不会再有下文
      for (const item of turn.items) if (item.status === 'inProgress') item.status = 'completed'
    }
    const first = this.turns[0]?.items[0]
    if (first?.type === 'userMessage') {
      const text = first.content
        .filter((part: any) => part?.type === 'text')
        .map((part: any) => part.text)
        .join('\n')
      if (text) this.thread.preview = text.slice(0, 200)
    }
    this.replaying = false
  }

  /** session/update 的一条。返回改了会话层面的什么（由 AcpServer 去通知） */
  update(update: any, notify: Notify): SessionChange {
    const kind = update?.sessionUpdate
    const quiet: Notify = () => {}
    const send = this.replaying ? quiet : notify
    switch (kind) {
      case 'user_message_chunk':
        // 实时回合里用户的话是适配器自己放的（客户端发来的样子），agent 回显的不再要
        if (this.replaying) this.replayUser(update)
        return null
      case 'agent_message_chunk':
        this.stream('message', update, send)
        return null
      case 'agent_thought_chunk':
        this.stream('thought', update, send)
        return null
      case 'tool_call':
      case 'tool_call_update':
        this.toolUpdate(update, send)
        return null
      case 'plan':
        if (this.active && !this.replaying)
          notify('turn/plan/updated', {
            turnId: this.active.id,
            explanation: null,
            plan: (Array.isArray(update.entries) ? update.entries : []).map((entry: any) => ({
              step: String(entry?.content ?? ''),
              status:
                entry?.status === 'in_progress'
                  ? 'inProgress'
                  : entry?.status === 'completed'
                    ? 'completed'
                    : 'pending',
            })),
          })
        return null
      case 'usage_update':
        this.usageUpdate(update, send)
        return null
      case 'available_commands_update':
        this.commands = Array.isArray(update.availableCommands) ? update.availableCommands : []
        return 'commands'
      case 'current_mode_update':
        if (this.modes && typeof update.currentModeId === 'string')
          this.modes.currentModeId = update.currentModeId
        return 'settings'
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) this.configOptions = update.configOptions
        return 'settings'
      case 'session_info_update': {
        const updatedAt = Date.parse(String(update.updatedAt ?? ''))
        if (Number.isFinite(updatedAt))
          this.thread.updatedAt = Math.max(this.thread.updatedAt, Math.floor(updatedAt / 1000))
        if (typeof update.title !== 'string' || !update.title || this.userNamed) return null
        if (update.title === this.thread.name) return null
        this.thread.name = update.title
        return 'name'
      }
      default:
        return null
    }
  }

  private toolUpdate(update: any, notify: Notify): void {
    const id = typeof update.toolCallId === 'string' ? update.toolCallId : null
    if (!id) return
    let state = this.tools.get(id)
    // 调用号只在一个回合里认：别的回合用过的同一个号（有的 agent 每回合从头数）是新的调用
    if (state && this.active && state.turn !== this.active) state = undefined
    if (!state) {
      const turn = this.active
      if (!turn) return
      this.closeCurrent(notify, false)
      const item = toolItem(`${turn.id}:tool:${id}`, update, this.thread.cwd, this.server)
      state = { item, turn, startedMs: Date.now(), declined: false, writes: new Map() }
      this.tools.set(id, state)
      this.put(turn, item, false, notify)
    }
    this.mergeTool(state, update, notify)
  }

  /** harness 标识：MCP 条目的 server 记成它（AcpServer 设） */
  server = 'acp'

  // 一次 tool_call_update 并进条目。完成或失败时发 item/completed；命令的输出能接上的发增量。
  private mergeTool(state: ToolState, update: any, notify: Notify): void {
    const { item, turn } = state
    const done = update.status === 'completed' || update.status === 'failed'
    // 收过尾的不再改（有的 agent 收尾之后还会再推一遍）
    if (item.status !== 'inProgress') return
    if (typeof update.title === 'string' && item.type === 'mcpToolCall') item.tool = update.title
    if (update.rawInput !== undefined && item.type === 'mcpToolCall')
      item.arguments = update.rawInput
    if (item.type === 'commandExecution') {
      if (typeof update.rawInput?.command === 'string') item.command = update.rawInput.command
      this.linkTerminals(state, update.content, notify)
      const text = contentText(update.content) || rawOutputText(update.rawOutput)
      if (text) this.commandOutput(item, turn, text, notify)
    } else if (item.type === 'fileChange' && Array.isArray(update.content)) {
      const changes = diffChanges(update.content, update.kind === 'delete')
      if (changes.length) item.changes = changes
    }
    if (!done) return
    const failed = update.status === 'failed'
    item.status = state.declined ? 'declined' : itemStatus(update.status)
    if (item.type === 'commandExecution') {
      if (state.declined) Object.assign(item, { aggregatedOutput: null, exitCode: null })
      else {
        item.exitCode = item.exitCode ?? exitCodeOf(update.rawOutput, failed)
        if (item.exitCode !== 0) item.status = 'failed'
        item.durationMs = Math.max(0, Date.now() - state.startedMs)
      }
    } else if (item.type === 'fileChange') {
      if (!item.changes.length) item.changes = [...state.writes.values()]
    } else {
      item.result = mcpResult(update)
      item.error = failed ? { message: contentText(update.content) || '工具调用失败' } : null
      item.durationMs = Math.max(0, Date.now() - state.startedMs)
    }
    // 回放的时长不是真的（调用和结果是一口气回放过来的）
    if (this.replaying && item.type !== 'fileChange') item.durationMs = null
    notify('item/completed', { turnId: turn.id, item })
  }

  // agent 每次推的多半是到现在为止的全部输出：能接上前一份的发新增的那段，接不上的只换掉
  //（协议的增量只能往后接，完成时的条目以全文为准）。
  private commandOutput(item: any, turn: AcpTurn, text: string, notify: Notify): void {
    const before = item.aggregatedOutput ?? ''
    if (text === before) return
    item.aggregatedOutput = text
    if (text.startsWith(before))
      notify('item/commandExecution/outputDelta', {
        turnId: turn.id,
        itemId: item.id,
        delta: text.slice(before.length),
      })
  }

  /** 我们的终端吐了一段输出：挂着这个终端、还在跑的命令条目接上 */
  terminalOutput(terminalId: string, delta: string, notify: Notify): void {
    for (const state of this.tools.values()) {
      const { item } = state
      if (item.status !== 'inProgress' || !this.linked.get(terminalId)?.has(item.id)) continue
      item.aggregatedOutput = (item.aggregatedOutput ?? '') + delta
      notify('item/commandExecution/outputDelta', { turnId: state.turn.id, itemId: item.id, delta })
    }
  }

  /** 终端到现在为止的输出（AcpServer 设）：命令条目刚挂上终端时先补上之前的那段 */
  terminalSoFar: (terminalId: string) => string = () => ''

  // 终端和命令条目的对应：工具内容里挂着终端时记下
  private readonly linked = new Map<string, Set<string>>()
  private linkTerminals(state: ToolState, content: unknown, notify: Notify): void {
    for (const terminalId of terminalIds(content)) {
      const items = this.linked.get(terminalId) ?? new Set<string>()
      if (items.has(state.item.id)) continue
      items.add(state.item.id)
      this.linked.set(terminalId, items)
      const before = this.terminalSoFar(terminalId)
      if (!before) continue
      state.item.aggregatedOutput = (state.item.aggregatedOutput ?? '') + before
      notify('item/commandExecution/outputDelta', {
        turnId: state.turn.id,
        itemId: state.item.id,
        delta: before,
      })
    }
  }

  /**
   * 权限请求里带的工具调用：已经有条目的并进去，还没有的照它建一个（有的 agent 先问再报调用）。
   * 返回它的状态，没有回合时是 undefined。
   */
  ensureTool(update: any, notify: Notify): ToolState | undefined {
    if (typeof update?.toolCallId !== 'string' || !this.active) return undefined
    const known = this.tools.get(update.toolCallId)
    if (known?.turn !== this.active) this.toolUpdate({ ...update, status: 'pending' }, notify)
    else this.mergeTool(known, { ...update, status: undefined }, notify)
    return this.tools.get(update.toolCallId)
  }

  /**
   * agent 经 fs/write_text_file 写了一个文件：挂到这一回合里还没收尾的改文件调用上（照路径对，对不上就是最近的那个）；
   * 没有这样的调用时单独记一个改文件条目。oldText 为 null 是新建的文件。
   */
  fileWritten(path: string, oldText: string | null, newText: string, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const change = fileChangeOf(path, oldText, newText)
    const open = [...this.tools.values()].filter(
      (state) =>
        state.turn === turn &&
        state.item.type === 'fileChange' &&
        state.item.status === 'inProgress',
    )
    const owner =
      open.find((state) => state.item.changes.some((entry: any) => entry.path === path)) ??
      open.at(-1)
    if (owner) {
      owner.writes.set(path, change)
      return
    }
    this.closeCurrent(notify, false)
    const item = {
      type: 'fileChange',
      id: this.nextId(turn, 'write'),
      status: 'completed',
      changes: [change],
    }
    this.put(turn, item, false, notify)
    notify('item/completed', { turnId: turn.id, item })
  }

  // usage_update：上下文里现在有多少词元、窗口多大。客户端拿 last.totalTokens 除以窗口算占用。
  private usageUpdate(update: any, notify: Notify): void {
    if (typeof update.size === 'number' && update.size > 0) this.contextWindow = update.size
    if (typeof update.used !== 'number') return
    this.last = { ...zero(), totalTokens: update.used, inputTokens: update.used }
    this.reportUsage(notify)
  }

  private reportUsage(notify: Notify): void {
    const turn = this.active ?? this.turns.at(-1)
    if (!turn || !this.last) return
    notify('thread/tokenUsage/updated', {
      turnId: turn.id,
      tokenUsage: {
        total: { ...this.total },
        last: { ...this.last },
        modelContextWindow: this.contextWindow,
      },
    })
  }

  // session/prompt 应答里的用量（这一回合一共用的）：累进总数；没收到过 usage_update 的回合拿它当这一次的
  private promptUsage(usage: any, notify: Notify): void {
    if (!usage || typeof usage.totalTokens !== 'number') return
    const turn: Breakdown = {
      totalTokens: usage.totalTokens,
      inputTokens:
        (usage.inputTokens ?? 0) + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
      cachedInputTokens: usage.cachedReadTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningOutputTokens: usage.thoughtTokens ?? 0,
    }
    for (const key of Object.keys(turn) as Array<keyof Breakdown>) this.total[key] += turn[key]
    this.last ??= turn
    this.reportUsage(notify)
  }

  /** 用户在审批里拒绝了：条目收尾时记成 declined（命令没跑） */
  decline(toolCallId: string): void {
    const state = this.tools.get(toolCallId)
    if (state) state.declined = true
  }

  /** 回合收尾：按 agent 的 stopReason（cancelled 是被打断），或者出错、被适配器收尾 */
  finish(outcome: TurnOutcome, notify: Notify, time = Date.now()): void {
    const turn = this.active
    if (!turn) return
    this.closeCurrent(notify, true)
    if ('usage' in outcome) this.promptUsage(outcome.usage, notify)
    turn.status =
      'error' in outcome
        ? 'failed'
        : 'interrupted' in outcome || outcome.stopReason === 'cancelled'
          ? 'interrupted'
          : 'completed'
    if ('error' in outcome)
      turn.error = { message: outcome.error, codexErrorInfo: null, additionalDetails: null }
    for (const state of this.tools.values()) {
      if (state.turn !== turn || state.item.status !== 'inProgress') continue
      state.item.status = state.declined
        ? 'declined'
        : turn.status === 'completed' && this.replaying
          ? 'completed'
          : 'failed'
      if (state.item.type === 'fileChange' && !state.item.changes.length)
        state.item.changes = [...state.writes.values()]
      notify('item/completed', { turnId: turn.id, item: state.item })
    }
    turn.completedAt = Math.floor(time / 1000)
    turn.durationMs = this.replaying
      ? null
      : Math.max(0, time - (this.startedMs.get(turn.id) ?? time))
    this.thread.updatedAt = Math.max(this.thread.updatedAt, turn.completedAt)
    this.active = null
    this.approving.clear()
    notify('turn/completed', { turn })
    notify('thread/status/changed', { status: this.status() })
  }

  /** 存进适配器库里的那一份（agent 回放不了历史时靠它，见 AcpServer.open） */
  snapshot(): AcpTurn[] {
    return this.turns.filter((turn) => turn.status !== 'inProgress')
  }

  /** 从库里存的那一份摆回来 */
  restore(turns: AcpTurn[]): void {
    this.turns.push(...turns)
  }
}
