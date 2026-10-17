import {
  declineItem,
  fileChanges,
  finishTool,
  gitStyleDiff,
  liveOutput,
  rejectedByUser,
  toolItem,
} from './items.mjs'

// 把 OpenCode 的消息和部件（message、part）归并成 Codex 的回合与条目；实时事件和重读历史共用同一套归并
//（重读历史就是把消息列表按先后当事件喂一遍，见文末的 replay）。
//
// 回合怎么切：OpenCode 一句用户的话是一条用户消息，模型的每一步是一条助手消息（parentID 指向那条用户消息）。
// 一个回合从一条用户消息开始，到会话闲下来（session.idle）结束；回合号就是那条用户消息的消息号，
// 适配器发消息时自己生成消息号交给 OpenCode（prompt_async 的 messageID），所以回合一开始就有号，前后一致。
// 回合进行中又来的用户消息（插话、压缩后 OpenCode 自己补的“接着做”、子任务的总结提示）并进当前回合。
// 重读历史时没有“进行中”可看，按内容定：适配器记下的插话、全是合成部件的、自动压缩的并进前一个回合，
// 别的另起一个回合。在别处（OpenCode 自己的界面）插的话实时并进当前回合，重读时另起回合，只差这一点。

export interface OcThread {
  id: string
  cwd: string
  // OpenCode 的标题原样；默认标题（New session - 时间）不当名字（见 envelope）
  title: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  parentThreadId: string | null
  // 临时线程只存在于适配器内存里，没有对应的 OpenCode 会话
  ephemeral: boolean
}

export interface OcTurn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}

export type Notify = (method: string, params: any) => void

export interface ProjectionHooks {
  /** 适配器记下的、客户端发来的那份输入和提交标识（按消息号）；没记的是 null */
  recorded(messageId: string): { content: any[]; clientId: string | null } | null
  /** 这条用户消息是不是适配器发的插话 */
  steer(messageId: string): boolean
  /** 模型的上下文窗口（provider 的模型目录里的 limit.context），不知道的是 null */
  contextWindow(providerID: string, modelID: string): number | null
  /** 现有的 MCP 服务名：拆 MCP 工具名用 */
  mcpServers(): readonly string[]
}

interface PartState {
  part: any
  item: any | null
  turn: OcTurn
  message: string
  done: boolean
  // 命令输出：上一次的全量快照
  output: string
}

const noop: Notify = () => {}
// OpenCode 的 /shell 建的那条用户消息里的合成文字（它的 session/prompt.ts 的 shellImpl）
const SHELL_MARK = 'The following tool was executed by the user'
const seconds = (ms: number) => Math.floor(ms / 1000)

export function errorText(error: any): string {
  return String(error?.data?.message ?? error?.message ?? error?.name ?? 'OpenCode 回合出错')
}

// 全量快照之间算增量：快照只留末尾一段（OpenCode 的 shell 工具超过 3 万字只留后面），前面被截掉时
// 按上一份的末尾在新的一份里找接续的位置；找不到就不发，命令结束时的完整输出会补上。
export function incremental(previous: string, next: string): string {
  if (next.startsWith(previous)) return next.slice(previous.length)
  const tail = previous.slice(-2000)
  const at = tail ? next.lastIndexOf(tail) : -1
  return at < 0 ? '' : next.slice(at + tail.length)
}

const realPart = (part: any) =>
  (part?.type === 'text' && !part.synthetic && !part.ignored) ||
  part?.type === 'file' ||
  part?.type === 'subtask'

// 用户消息的部件转成协议里的输入（没有记下的输入时用）：用户自己写的字、图片、文件引用。
function userContent(parts: any[]): any[] {
  const content: any[] = []
  for (const part of parts) {
    if (part.type === 'text' && !part.synthetic && !part.ignored)
      content.push({ type: 'text', text: String(part.text ?? ''), text_elements: [] })
    else if (part.type === 'file') {
      const url = String(part.url ?? '')
      const image = String(part.mime ?? '').startsWith('image/')
      if (image && url.startsWith('data:')) content.push({ type: 'image', url })
      else if (url.startsWith('file://')) {
        const path = decodeURIComponent(new URL(url).pathname)
        content.push(
          image
            ? { type: 'localImage', path }
            : { type: 'mention', name: String(part.filename ?? path), path },
        )
      }
    } else if (part.type === 'subtask')
      content.push({ type: 'text', text: String(part.prompt ?? ''), text_elements: [] })
  }
  return content
}

const firstText = (content: any[]): string =>
  content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n')

export class Projection {
  readonly thread: OcThread
  readonly turns: OcTurn[] = []
  active: OcTurn | null = null
  private readonly hooks: ProjectionHooks
  private readonly messages = new Map<string, any>()
  private readonly owner = new Map<string, OcTurn>()
  private readonly userParts = new Map<string, Map<string, any>>()
  // 还没回显的用户消息（部件没到齐），按回合
  private readonly unflushed = new Map<string, OcTurn>()
  private readonly parts = new Map<string, PartState>()
  private readonly byMessage = new Map<string, PartState[]>()
  private readonly calls = new Map<string, PartState>()
  private readonly open = new Set<string>()
  // 计划模式（agent=plan）的回合：模型说的话进计划条目
  private readonly planTurns = new Set<string>()
  private readonly startedMs = new Map<string, number>()
  private readonly lastDiff = new Map<string, string>()
  private readonly turnError = new Map<string, any>()
  private readonly counted = new Set<string>()
  // 审批时 OpenCode 给的 diff（按工具调用号），和被用户拒绝了的调用
  private readonly approvalDiffs = new Map<string, string>()
  private readonly declined = new Set<string>()
  private readonly approving = new Set<symbol>()
  private readonly asking = new Set<symbol>()
  private readonly shellTurns = new Set<string>()
  // 用户消息已经到了的回合（见 idle）
  private readonly seen = new Set<string>()
  // 适配器打断的回合：结束时按“被打断”收尾
  interrupting: string | null = null
  private readonly usage = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    cacheWriteInputTokens: 0,
  }

  constructor(thread: OcThread, hooks: ProjectionHooks) {
    this.thread = thread
    this.hooks = hooks
  }

  /**
   * 线程现在的状态，照上游（app-server 的 thread_status.rs）：有审批在等是 waitingOnApproval，
   * 有提问在等是 waitingOnUserInput，可以同时有；有回合在跑或者有事在等就是 active。
   */
  status(): any {
    const activeFlags = [
      ...(this.approving.size ? ['waitingOnApproval'] : []),
      ...(this.asking.size ? ['waitingOnUserInput'] : []),
    ]
    return this.active || activeFlags.length ? { type: 'active', activeFlags } : { type: 'idle' }
  }

  /** 等用户的这段时间把线程标成在等，等完改回来；回合结束时一并清掉 */
  async waiting<T>(
    kind: 'approval' | 'question',
    notify: Notify,
    work: () => Promise<T>,
  ): Promise<T> {
    const pending = kind === 'approval' ? this.approving : this.asking
    const mark = Symbol(kind)
    pending.add(mark)
    notify('thread/status/changed', { status: this.status() })
    try {
      return await work()
    } finally {
      if (pending.delete(mark)) notify('thread/status/changed', { status: this.status() })
    }
  }

  /** 工具调用号对应的条目（审批、提问按它找条目） */
  itemByCall(callID: unknown): any {
    return typeof callID === 'string' ? (this.calls.get(callID)?.item ?? undefined) : undefined
  }

  /** 审批时 OpenCode 给了这次改动的 diff：记下，文件改动条目用它 */
  approvalDiff(callID: string, diff: string, notify: Notify): void {
    this.approvalDiffs.set(callID, diff)
    const state = this.calls.get(callID)
    if (!state?.item || state.done || state.item.type !== 'fileChange') return
    state.item.changes = fileChanges(state.part, this.thread.cwd, diff, state.item.changes)
    notify('item/fileChange/patchUpdated', {
      turnId: state.turn.id,
      itemId: state.item.id,
      changes: state.item.changes,
    })
  }

  /** 用户在审批里拒绝了这次调用 */
  decline(callID: string): void {
    this.declined.add(callID)
  }

  /** 这个回合是不是计划模式 */
  planning(turnId: string): boolean {
    return this.planTurns.has(turnId)
  }

  // 适配器发消息前先建好回合（回合号就是要交给 OpenCode 的消息号），随后到的那条用户消息与它对上。
  expect(id: string, plan: boolean, notify: Notify): OcTurn {
    return this.begin(id, Date.now(), plan, notify)
  }

  /** message.updated：startsTurn 只在重读历史时由调用方给（见 replay），实时按“有没有进行中的回合”定 */
  message(info: any, notify: Notify, startsTurn = !this.active): void {
    const known = this.messages.has(info.id)
    this.messages.set(info.id, info)
    const created = Number(info.time?.created ?? Date.now())
    this.thread.updatedAt = Math.max(this.thread.updatedAt, seconds(created))
    if (info.role === 'user') {
      let turn = this.owner.get(info.id)
      if (!turn) {
        turn =
          this.active && (this.active.id === info.id || !startsTurn)
            ? this.active
            : this.begin(info.id, created, info.agent === 'plan', notify)
        this.owner.set(info.id, turn)
        this.seen.add(turn.id)
        this.unflushed.set(info.id, turn)
        // 记下了客户端发来的那份就当场回显；没记的等部件到齐（第一条助手消息来的时候，或者回合结束时）
        if (this.hooks.recorded(info.id)) this.flushUser(info.id, notify)
      }
      this.diff(turn, info, notify)
      return
    }
    const turn = this.owner.get(info.id) ?? this.owner.get(info.parentID) ?? this.active
    if (!turn) return
    this.owner.set(info.id, turn)
    if (!known)
      for (const [id, owner] of [...this.unflushed]) if (owner === turn) this.flushUser(id, notify)
    if (info.error) this.turnError.set(turn.id, info.error)
    if (info.time?.completed) this.closeTexts(info.id, notify)
  }

  /** message.part.updated */
  part(part: any, notify: Notify): void {
    const info = this.messages.get(part.messageID)
    const turn = this.owner.get(part.messageID)
    if (!info || !turn) return
    if (info.role === 'user') {
      const parts = this.userParts.get(info.id) ?? new Map<string, any>()
      parts.set(part.id, part)
      this.userParts.set(info.id, parts)
      // 用户自己跑的命令（thread/shellCommand 经 OpenCode 的 /shell）：这一轮里的命令条目标成 userShell
      if (part.type === 'text' && part.synthetic && part.text === SHELL_MARK)
        this.shellTurns.add(turn.id)
      // 压缩：一条带压缩部件的用户消息，画成一个上下文压缩条目
      if (part.type === 'compaction' && !turn.items.some((item) => item.id === part.id))
        this.put(turn, { type: 'contextCompaction', id: part.id }, true, notify)
      return
    }
    // 压缩时的那条摘要（summary 为真的助手消息）不当回答显示
    if (info.summary === true && part.type !== 'step-finish') return
    if (part.type === 'text' && !part.synthetic && !part.ignored)
      this.text(turn, info, part, notify)
    else if (part.type === 'reasoning') this.reasoning(turn, info, part, notify)
    else if (part.type === 'tool' && part.tool !== 'StructuredOutput')
      this.tool(turn, info, part, notify)
    else if (part.type === 'step-finish') {
      this.tokens(turn, info, part, notify)
      this.closeTexts(info.id, notify)
    }
  }

  /** message.part.delta：文字一段段到（只认 text 这个字段） */
  delta(partID: string, field: string, delta: string, notify: Notify): void {
    const state = this.parts.get(partID)
    if (!state?.item || state.done || field !== 'text') return
    const item = state.item
    const current = item.type === 'reasoning' ? item.summary[0] : item.text
    this.grow(state, current + delta, notify)
  }

  /** todo.updated：照上游的 update_plan 发 turn/plan/updated；没有进行中的回合时没有回合号可挂，不发 */
  todos(list: unknown, notify: Notify): void {
    const turn = this.active
    if (!turn || !Array.isArray(list)) return
    const status = (value: string) =>
      value === 'in_progress' ? 'inProgress' : value === 'pending' ? 'pending' : 'completed'
    notify('turn/plan/updated', {
      turnId: turn.id,
      explanation: null,
      plan: list.map((todo: any) => ({
        step: String(todo?.content ?? ''),
        status: status(String(todo?.status ?? 'pending')),
      })),
    })
  }

  /**
   * session.error：记下来，回合结束时用它（助手消息自己没带错误时）。适配器建的回合还没等到它的那条用户消息就出错的
   *（模型不存在这类，OpenCode 在后台建消息之前就失败了，会话一直是闲的、不会再有 idle），当场按失败收尾。
   */
  error(error: unknown, notify: Notify): void {
    const turn = this.active
    if (!turn || !error) return
    this.turnError.set(turn.id, error)
    if (!this.seen.has(turn.id)) this.end('failed', errorText(error), Date.now(), notify)
  }

  /** session.status 为 retry：照上游发一条 willRetry 的 error 通知，回合接着等 */
  retry(status: any, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    notify('error', {
      turnId: turn.id,
      willRetry: true,
      error: {
        message: String(status?.message ?? 'OpenCode 正在重试'),
        codexErrorInfo: null,
        additionalDetails: null,
      },
    })
  }

  /** 这个回合的那条用户消息 OpenCode 已经建了（回合真的开始跑了） */
  started(turnId: string): boolean {
    return this.seen.has(turnId)
  }

  /**
   * 会话闲下来了（session.idle）：进行中的回合照它最后的样子收尾。适配器建的回合在它的用户消息到之前不认闲：
   * 那时的“闲”是上一个回合留下的（idle 和 session.status 前后脚到），回合还没开始跑。
   */
  idle(notify: Notify, time = Date.now()): void {
    const turn = this.active
    if (turn && this.seen.has(turn.id)) this.settle(turn, notify, time)
  }

  private settle(turn: OcTurn, notify: Notify, time: number): void {
    const error = this.lastAssistant(turn)?.error ?? this.turnError.get(turn.id)
    if (this.interrupting === turn.id || error?.name === 'MessageAbortedError')
      this.end('interrupted', null, time, notify)
    else if (error) this.end('failed', errorText(error), time, notify)
    else this.end('completed', null, time, notify)
  }

  // 进程中断等异常情况下由适配器直接收尾。
  fail(message: string, notify: Notify): void {
    this.end('failed', message, Date.now(), notify)
  }

  // 打断之后 OpenCode 迟迟没有回报闲下来时，由适配器按“被打断”收尾。
  stop(notify: Notify): void {
    this.end('interrupted', null, Date.now(), notify)
  }

  private lastAssistant(turn: OcTurn): any {
    let last: any = null
    for (const [id, info] of this.messages)
      if (info.role === 'assistant' && this.owner.get(id) === turn) last = info
    return last
  }

  private begin(id: string, time: number, plan: boolean, notify: Notify): OcTurn {
    if (this.active) this.settle(this.active, notify, time)
    const turn: OcTurn = {
      id,
      items: [],
      status: 'inProgress',
      error: null,
      startedAt: seconds(time),
      completedAt: null,
      durationMs: null,
    }
    if (plan) this.planTurns.add(id)
    this.startedMs.set(id, time)
    this.turns.push(turn)
    this.active = turn
    notify('turn/started', { turn })
    notify('thread/status/changed', { status: this.status() })
    return turn
  }

  private put(turn: OcTurn, item: any, complete: boolean, notify: Notify, at?: number): any {
    if (!turn.items.includes(item)) {
      if (at === undefined) turn.items.push(item)
      else turn.items.splice(at, 0, item)
      this.open.add(item.id)
      notify('item/started', {
        turnId: turn.id,
        item: item.type === 'reasoning' ? { ...item, summary: [], content: [] } : item,
      })
      if (item.type === 'reasoning')
        notify('item/reasoning/summaryPartAdded', {
          turnId: turn.id,
          itemId: item.id,
          summaryIndex: 0,
        })
    }
    if (complete && this.open.delete(item.id)) notify('item/completed', { turnId: turn.id, item })
    return item
  }

  // 回显一条用户消息：内容是客户端发来的样子（记下的那份），没记的照 OpenCode 的部件来；
  // 一个字都没有的（全是合成部件：压缩后的“接着做”这类）不画。回合自己的那条排在最前面，插话排在后面。
  private flushUser(id: string, notify: Notify): void {
    const turn = this.unflushed.get(id)
    if (!turn) return
    this.unflushed.delete(id)
    const parts = [...(this.userParts.get(id)?.values() ?? [])]
    const recorded = this.hooks.recorded(id)
    const content = recorded?.content ?? userContent(parts)
    if (!content.length) return
    if (!this.thread.preview)
      this.thread.preview = (firstText(content) || firstText(userContent(parts))).slice(0, 200)
    const item = { type: 'userMessage', id, content, clientId: recorded?.clientId ?? null }
    this.put(turn, item, true, notify, turn.id === id ? 0 : undefined)
  }

  // 用户消息的 summary.diffs（OpenCode 照快照算的这一轮的改动）变了就发 turn/diff/updated。只在回合进行中发。
  private diff(turn: OcTurn, info: any, notify: Notify): void {
    const diffs: any[] = Array.isArray(info.summary?.diffs) ? info.summary.diffs : []
    if (turn !== this.active || info.id !== turn.id) return
    const patch = diffs
      .map(gitStyleDiff)
      .filter(Boolean)
      .map((entry) => `${entry}\n`)
      .join('')
    if (patch === (this.lastDiff.get(turn.id) ?? '')) return
    this.lastDiff.set(turn.id, patch)
    notify('turn/diff/updated', { turnId: turn.id, diff: patch })
  }

  private track(turn: OcTurn, info: any, part: any, item: any): PartState {
    const state: PartState = { part, item, turn, message: info.id, done: false, output: '' }
    this.parts.set(part.id, state)
    const list = this.byMessage.get(info.id) ?? []
    list.push(state)
    this.byMessage.set(info.id, list)
    if (typeof part.callID === 'string') this.calls.set(part.callID, state)
    return state
  }

  // 文字和推理：全量比已发出的多的部分当增量补发（重连之后、或者增量没赶上时）；对不上就直接换成全量。
  private grow(state: PartState, text: string, notify: Notify): void {
    const item = state.item
    const reasoning = item.type === 'reasoning'
    const current: string = reasoning ? item.summary[0] : item.text
    if (text === current) return
    if (reasoning) item.summary[0] = text
    else item.text = text
    if (!text.startsWith(current)) return
    const delta = text.slice(current.length)
    const base = { turnId: state.turn.id, itemId: item.id, delta }
    if (reasoning) notify('item/reasoning/summaryTextDelta', { ...base, summaryIndex: 0 })
    else if (item.type === 'plan') notify('item/plan/delta', base)
    else notify('item/agentMessage/delta', base)
  }

  private text(turn: OcTurn, info: any, part: any, notify: Notify): void {
    let state = this.parts.get(part.id)
    if (!state) {
      // 一段话是过程说明还是最终回答，要等这一步结束、看它带不带工具调用才知道：开始时一律先报成最终回答。
      const item = this.planTurns.has(turn.id)
        ? { type: 'plan', id: part.id, text: '' }
        : {
            type: 'agentMessage',
            id: part.id,
            text: '',
            phase: 'final_answer',
            memoryCitation: null,
          }
      state = this.track(turn, info, part, item)
      this.put(turn, item, false, notify)
    }
    if (!state.done) this.grow(state, String(part.text ?? ''), notify)
  }

  private reasoning(turn: OcTurn, info: any, part: any, notify: Notify): void {
    let state = this.parts.get(part.id)
    if (!state) {
      const item = { type: 'reasoning', id: part.id, summary: [''], content: [] }
      state = this.track(turn, info, part, item)
      this.put(turn, item, false, notify)
    }
    if (state.done) return
    this.grow(state, String(part.text ?? ''), notify)
    if (part.time?.end) {
      state.done = true
      this.put(turn, state.item, true, notify)
    }
  }

  private tool(turn: OcTurn, info: any, part: any, notify: Notify): void {
    const status = part.state?.status
    let state = this.parts.get(part.id)
    if (!state) {
      // pending 时参数还没齐，等它开始跑（或者直接到了终态）再画
      if (status === 'pending') return
      const item = toolItem(part, this.thread.cwd, this.hooks.mcpServers())
      state = this.track(turn, info, part, item)
      if (!item) {
        state.done = true
        return
      }
      if (item.type === 'commandExecution' && this.shellTurns.has(turn.id))
        item.source = 'userShell'
      this.put(turn, item, false, notify)
    }
    state.part = part
    const item = state.item
    if (!item || state.done) return
    if (item.type === 'commandExecution') {
      const output = liveOutput(part)
      if (output !== null) {
        const delta = incremental(state.output, output)
        state.output = output
        if (delta)
          notify('item/commandExecution/outputDelta', { turnId: turn.id, itemId: item.id, delta })
      }
    }
    if (status !== 'completed' && status !== 'error') return
    const callID = String(part.callID ?? '')
    finishTool(item, part, this.thread.cwd, this.approvalDiffs.get(callID) ?? null)
    if (status === 'error' && (this.declined.has(callID) || rejectedByUser(part.state?.error)))
      declineItem(item)
    state.done = true
    this.put(turn, item, true, notify)
  }

  // 一步结束（step-finish）带着这一步的用量：照上游累计，last 是这一步的。
  // OpenCode 的 input 不含缓存命中和写缓存的部分，协议的 inputTokens 含。
  private tokens(turn: OcTurn, info: any, part: any, notify: Notify): void {
    if (this.counted.has(part.id)) return
    this.counted.add(part.id)
    const t = part.tokens ?? {}
    const read = Number(t.cache?.read ?? 0)
    const write = Number(t.cache?.write ?? 0)
    const last = {
      totalTokens:
        Number(t.total ?? 0) || Number(t.input ?? 0) + read + write + Number(t.output ?? 0),
      inputTokens: Number(t.input ?? 0) + read + write,
      cachedInputTokens: read,
      outputTokens: Number(t.output ?? 0),
      reasoningOutputTokens: Number(t.reasoning ?? 0),
      cacheWriteInputTokens: write,
    }
    if (!last.totalTokens) return
    for (const key of Object.keys(last) as Array<keyof typeof last>) this.usage[key] += last[key]
    notify('thread/tokenUsage/updated', {
      turnId: turn.id,
      tokenUsage: {
        total: { ...this.usage },
        last,
        modelContextWindow: this.hooks.contextWindow(String(info.providerID), String(info.modelID)),
      },
    })
  }

  // 一步结束时把这一步的文字收尾：这一步里有工具调用的话，它说的是过程说明，否则是最终回答。
  private closeTexts(messageId: string, notify: Notify): void {
    const states = this.byMessage.get(messageId) ?? []
    const commentary = states.some((state) => state.part.type === 'tool')
    for (const state of states) {
      if (state.done || state.part.type !== 'text') continue
      state.done = true
      if (state.item.type === 'agentMessage')
        state.item.phase = commentary ? 'commentary' : 'final_answer'
      this.put(state.turn, state.item, true, notify)
    }
  }

  private end(status: OcTurn['status'], message: string | null, time: number, notify: Notify) {
    const turn = this.active
    if (!turn) return
    for (const [id, owner] of [...this.unflushed]) if (owner === turn) this.flushUser(id, notify)
    for (const state of this.parts.values()) {
      if (state.turn !== turn || state.done || !state.item) continue
      state.done = true
      if (state.item.type === 'agentMessage') {
        const commentary = (this.byMessage.get(state.message) ?? []).some(
          (entry) => entry.part.type === 'tool',
        )
        state.item.phase = commentary ? 'commentary' : 'final_answer'
      }
    }
    // 结构化输出（带 outputSchema 的回合）：OpenCode 把结果放在最后一条助手消息的 structured 上，画成一段回答
    const last = this.lastAssistant(turn)
    if (last && last.structured !== undefined && status === 'completed')
      this.put(
        turn,
        {
          type: 'agentMessage',
          id: `${last.id}:structured`,
          text: JSON.stringify(last.structured),
          phase: 'final_answer',
          memoryCitation: null,
        },
        true,
        notify,
      )
    for (const item of turn.items) {
      if (!this.open.delete(item.id)) continue
      if (item.status === 'inProgress') item.status = 'failed'
      notify('item/completed', { turnId: turn.id, item })
    }
    turn.status = status
    if (status === 'failed')
      turn.error = {
        message: message ?? 'OpenCode 回合出错',
        codexErrorInfo: null,
        additionalDetails: null,
      }
    turn.completedAt = seconds(time)
    turn.durationMs = Math.max(0, time - (this.startedMs.get(turn.id) ?? time))
    this.active = null
    if (this.interrupting === turn.id) this.interrupting = null
    this.approving.clear()
    this.asking.clear()
    notify('turn/completed', { turn })
    notify('thread/status/changed', { status: this.status() })
  }
}

// 重读历史时，一条用户消息另起回合还是并进前一个回合（见文件开头）。
function startsTurn(info: any, parts: any[], active: OcTurn | null, hooks: ProjectionHooks) {
  if (!active) return true
  if (hooks.steer(info.id)) return false
  const compaction = parts.find((part) => part?.type === 'compaction')
  if (compaction) return compaction.auto !== true
  return parts.some(realPart)
}

/**
 * 从消息列表（GET /session/{id}/message 的原样，按先后）重建投影。revert 是会话的回退点：
 * OpenCode 回退后、下一次发消息之前，回退点及以后的消息还在库里，只是作废了（它自己的界面也不显示），这里也不算。
 * busy：会话正在跑（别处发起的，或者适配器重启前发起的），最后一个回合留着进行中，之后的事件接着往里归。
 */
export function replay(
  thread: OcThread,
  messages: any[],
  hooks: ProjectionHooks,
  revert: string | null,
  busy: boolean,
): Projection {
  const projection = new Projection(thread, hooks)
  for (const entry of messages) {
    const info = entry?.info
    if (!info?.id || (revert && info.id >= revert)) continue
    const parts: any[] = Array.isArray(entry.parts) ? entry.parts : []
    const starts = info.role === 'user' ? startsTurn(info, parts, projection.active, hooks) : false
    projection.message(info, noop, starts)
    for (const part of parts) projection.part(part, noop)
  }
  if (projection.active && !busy) {
    const last = messages.at(-1)?.info
    projection.idle(noop, Number(last?.time?.completed ?? last?.time?.created ?? Date.now()))
  }
  return projection
}
