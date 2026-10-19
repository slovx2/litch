import { createTwoFilesPatch } from 'diff'
import { answerContent, userQuestions } from './questions.mjs'

export type Preset = 'read-only' | 'workspace-write' | 'danger-full-access'
export interface DshThread {
  id: string
  cwd: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  model: string | null
  effort: string | null
  preset: Preset
  // 这是 dsh 的子代理时，派它出来的会话（dsh 会话头里 origin 是 subagent 的 parentSession）。
  // dsh 自己分叉出来的会话也带 parentSession，但没有 origin：那是 forkedFromId，不是子代理。
  parentThreadId: string | null
  forkedFromId: string | null
  // 临时线程只存在于适配器内存里，没有对应的 dsh 会话。
  ephemeral: boolean
}

/** 子代理的方式：continuable 是后台跑、能接着发消息的；one-shot 跑完就结束，不能再对话 */
export type SubagentMode = 'one-shot' | 'continuable'
/** 一个子代理的情况：派它的会话里的 subagent/catalog 事件、它自己的 subagent/descriptor 事件里有 */
export interface SubagentInfo {
  mode: SubagentMode | null
  label: string | null
}

/** 投影要向外问、向外报的几件事（DshServer 给） */
export interface ProjectionHooks {
  // 按提交标识找适配器记下的、客户端发来的那份输入（DshServer.remember），没记的是 null。
  recorded?: (requestId: string) => any[] | null
  // 模型看到的工具名是不是这个会话的客户端工具（client-tools.mts），是的话是哪个命名空间的哪个工具
  clientTool?: (name: string) => { namespace: string | null; tool: string } | null
  // 见到了一个子代理的情况（派出去的、自己就是子代理的）
  subagent?: (threadId: string, info: SubagentInfo) => void
  // 把客户端在 dsh 起标题之前给的名字钉成 dsh 的用户标题（session/rename，见 Projection.wanted）
  pin?: (name: string) => void
}
export interface DshTurn {
  id: string
  items: any[]
  status: 'inProgress' | 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo: null; additionalDetails: null } | null
  startedAt: number
  completedAt: number | null
  durationMs: number | null
}
export interface WireEvent {
  type: string
  seq: number
  time: number
  data: any
}
export type Notify = (method: string, params: any) => void

const text = (content: any): string =>
  (Array.isArray(content) ? content : [])
    .filter((part: any) => part?.type === 'text')
    .map((part: any) => part.text)
    .join('\n')
const parse = (json: unknown): any => {
  try {
    return typeof json === 'string' ? JSON.parse(json) : (json ?? {})
  } catch {
    return {}
  }
}
const PRESETS: readonly Preset[] = ['read-only', 'workspace-write', 'danger-full-access']
/** dsh 的权限预设、沙箱方式里，和三个权限档对得上的那些；别的（用户自己配的、子代理的 custom）是 null */
export const knownPreset = (value: unknown): Preset | null =>
  PRESETS.includes(value as Preset) ? (value as Preset) : null
const optionalText = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null
const subagentMode = (value: unknown): SubagentMode | null =>
  value === 'continuable' || value === 'one-shot' ? value : null
const selectionKey = (value: any): unknown[] | null =>
  value ? [value.provider, value.model, value.reasoningEffort ?? null] : null

// dsh 的子代理工具，映射成协议的子代理条目（collabAgentToolCall）：subagent、subagent_fork 是派一个出去，
// send_message 是给子代理（或者子代理给它的上级）发消息，interrupt_agent 是打断，list_agents 是列出来
const COLLAB_TOOLS: Record<string, string> = {
  subagent: 'spawnAgent',
  subagent_fork: 'spawnAgent',
  send_message: 'sendInput',
  interrupt_agent: 'interruptAgent',
  list_agents: 'listAgents',
}

export function toolItem(
  id: string,
  name: string,
  args: any,
  thread: DshThread,
  clientTool: ProjectionHooks['clientTool'],
): any {
  const cwd = thread.cwd
  const client = clientTool?.(name)
  // 客户端工具（thread/start 带来的动态工具）：和 Claude、Pi 入口一样是动态工具条目
  if (client)
    return {
      type: 'dynamicToolCall',
      id,
      namespace: client.namespace,
      tool: client.tool,
      arguments: args,
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    }
  const collab = COLLAB_TOOLS[name]
  if (collab) {
    const target = typeof args.agent_id === 'string' ? args.agent_id : null
    return {
      type: 'collabAgentToolCall',
      id,
      // 子代理给它的上级发消息是 sendMessage，别的方向是 sendInput
      tool:
        collab === 'sendInput' && target && target === thread.parentThreadId
          ? 'sendMessage'
          : collab,
      status: 'inProgress',
      senderThreadId: thread.id,
      // 派出去的那个，到 subagent/catalog 事件（或者工具结果）才知道是谁
      receiverThreadIds: target ? [target] : [],
      prompt:
        typeof args.prompt === 'string'
          ? args.prompt
          : typeof args.message === 'string'
            ? args.message
            : null,
      model:
        typeof args.provider === 'string' && typeof args.model === 'string'
          ? `${args.provider}/${args.model}`
          : null,
      reasoningEffort: typeof args.reasoning_effort === 'string' ? args.reasoning_effort : null,
      agentsStates: {},
    }
  }
  // Windows 上 dsh 跑命令的工具叫 pwsh，参数和 bash 一样
  if (name === 'bash' || name === 'pwsh')
    return {
      type: 'commandExecution',
      id,
      command: String(args.command ?? ''),
      cwd: typeof args.workdir === 'string' ? args.workdir : cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  if (name === 'edit' || name === 'write')
    return { type: 'fileChange', id, status: 'inProgress', changes: [] }
  // 问用户的工具：和 Claude 入口一样是一个动态工具条目，参数是发给客户端的那几道题（questions.mts）。
  if (name === 'ask_user_question')
    return {
      type: 'dynamicToolCall',
      id,
      namespace: 'dsh',
      tool: name,
      arguments: { questions: userQuestions(args.questions) },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    }
  return {
    type: 'mcpToolCall',
    id,
    server: name.startsWith('mcp__') ? name.split('__')[1] : 'dsh',
    tool: name,
    status: 'inProgress',
    arguments: args,
    result: null,
    error: null,
    durationMs: null,
  }
}

function finishTool(item: any, args: any, message: any, meta: any): void {
  const failed = message?.isError === true
  const output = text(message?.content)
  item.status = failed ? 'failed' : 'completed'
  if (item.type === 'commandExecution') {
    // dsh 把退出码拼在输出文本末尾；非零退出不算工具错误。
    const code = /\[exit code: (\d+)\]\s*$/.exec(output)
    item.aggregatedOutput = output
    item.exitCode = code ? Number(code[1]) : failed ? 1 : 0
    if (item.exitCode !== 0) item.status = 'failed'
  } else if (item.type === 'fileChange') {
    if (failed) return
    const path = String(args.file_path ?? '')
    const diffs: any[] = Array.isArray(meta?.diffs) ? meta.diffs : []
    // 协议 add 承载文件正文，update 承载 unified diff；dsh 的 diff 是带上下文的新旧片段。
    item.changes = diffs.length
      ? diffs.map((diff) => ({
          path,
          kind: { type: 'update', move_path: null },
          diff: createTwoFilesPatch(
            path,
            path,
            `${diff.oldText ?? ''}\n`,
            `${diff.newText ?? ''}\n`,
          ),
        }))
      : [{ path, kind: { type: 'add' }, diff: String(args.content ?? '') }]
  } else if (isQuestion(item)) {
    // 答了的是每道题一行答案；没问成、被中止的是 dsh 交给模型的那句报错
    item.success = !failed
    item.contentItems = failed
      ? [{ type: 'inputText', text: output }]
      : answerContent(item.arguments.questions, args?.questions, output)
  } else if (item.type === 'dynamicToolCall') {
    // 客户端工具：结果是客户端答的那些字。图片在 dsh 的记录里只剩附件号，这里不带
    item.success = !failed
    item.contentItems = output ? [{ type: 'inputText', text: output }] : []
  } else if (item.type === 'collabAgentToolCall') {
    finishCollab(item, failed, output)
  } else {
    item.result = { content: message?.content ?? [], structuredContent: null, _meta: null }
    item.error = failed ? { message: output } : null
  }
}

// dsh 的提问工具的条目（见 toolItem）。客户端工具的条目也是动态工具条目，靠命名空间和工具名分开
const isQuestion = (item: any): boolean =>
  item.type === 'dynamicToolCall' && item.namespace === 'dsh' && item.tool === 'ask_user_question'

// 子代理条目收尾。派出去的：后台跑的结果是“started subagent <号>”，子代理还在跑；前台跑的结果就是它的回答
function finishCollab(item: any, failed: boolean, output: string): void {
  if (item.tool !== 'spawnAgent') return
  const started = /^started subagent (\S+)/.exec(output)
  if (started?.[1] && !item.receiverThreadIds.length) item.receiverThreadIds = [started[1]]
  const background = started !== null || /^started background subagent job /.test(output)
  for (const child of item.receiverThreadIds)
    item.agentsStates[child] = failed
      ? { status: 'errored', message: output || null }
      : background
        ? { status: 'running', message: null }
        : { status: 'completed', message: output || null }
}

/**
 * 用户在审批里拒绝的调用，照上游（app-server 答复审批时的 complete_command_execution_item）收尾：
 * 命令没跑，没有输出、退出码和时长，dsh 交回的那句拒绝的话只是给模型看的，等审批的那段也不是命令的时长；
 * 和 Claude Code（declinedToolItem）、Pi（declineItem）入口一样。协议里没有这种状态的条目留着失败。
 */
function declineItem(item: any): void {
  if (item.type === 'commandExecution')
    Object.assign(item, {
      status: 'declined',
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    })
  else if (item.type === 'fileChange') item.status = 'declined'
}

// 把 dsh 的落盘事件与实时增量归并成 Codex 的回合与条目；历史回放与实时共用同一套归并。
export class Projection {
  readonly thread: DshThread
  readonly turns: DshTurn[] = []
  active: DshTurn | null = null
  turnNumber = 0
  contextWindow: number | null = null
  // dsh 是否已经给这个会话起过标题（任何来源）；在此之前客户端写来的名字只算临时名。
  titled = false
  // dsh 那边算数的名字：它的模型起的、用户改的。它的兜底标题不算（见 title），最近的一个记在 fallback。
  named: string | null = null
  fallback: string | null = null
  // dsh 起标题之前客户端写来的名字（thread/name/set）。官方桌面端在首条消息前写回的是消息原文，那只是临时名；
  // 和头一句话不一样的是有意起的名字（比如设备进程给派出的子会话起的），dsh 的第一个标题来时钉住它，不让模型标题盖掉
  wanted: string | null = null
  // 选了模型、还没有哪一次请求用上（见 requested）。
  private chosen = false
  private expected = false
  private attempt: { turn: number; step: number } | null = null
  private readonly open = new Set<string>()
  // 协议里回合的起止时间是秒，时长是毫秒；毫秒级的开始时间另存一份用来算时长。
  private readonly startedMs = new Map<string, number>()
  private readonly calls = new Map<
    string,
    { item: any; args: any; done: boolean; startedMs: number; declined?: boolean }
  >()
  // 审批编号到工具调用的对应；裁决事件只带审批编号。
  private readonly asked = new Map<string, string>()
  // 已经对上了 dsh 的提问请求的提问调用（见 claimQuestion）。
  private readonly claimed = new Set<string>()
  // 正在等用户的审批和提问，一件一个记号（见 waiting）。线程状态上的标记按它们现算（见 status）。
  private readonly approving = new Set<symbol>()
  private readonly asking = new Set<symbol>()
  private readonly usage = {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
  // 没有记录的用户消息里的图片（见 userMessage）：dsh 的记录里只有附件号，内容要另去取，
  // 取了补进那条消息的内容里（DshServer.restoreImages）。
  readonly unfetched: { content: any[]; attachmentId: string }[] = []
  // 这个会话自己是子代理时，它是哪种（会话记录开头的 subagent/descriptor）
  subagent: SubagentInfo | null = null
  private readonly hooks: ProjectionHooks

  constructor(thread: DshThread, hooks: ProjectionHooks = {}) {
    this.thread = thread
    this.hooks = hooks
  }

  call(id: string): { item: any; args: any } | undefined {
    return this.calls.get(id)
  }

  /**
   * 线程现在的状态。在等用户时带上对应的标记，客户端靠它提示“待审批”“待回答”。照上游
   *（app-server 的 thread_status.rs 的 loaded_thread_status）：有审批在等是 waitingOnApproval，有提问在等是
   * waitingOnUserInput，可以同时有，次序也是这样；有回合在跑或者有事在等就是 active。
   * 报线程状态的每一处都用它：通知、回合开始和结束、会话对象（envelope）。
   */
  status(): any {
    const activeFlags = [
      ...(this.approving.size ? ['waitingOnApproval'] : []),
      ...(this.asking.size ? ['waitingOnUserInput'] : []),
    ]
    return this.active || activeFlags.length ? { type: 'active', activeFlags } : { type: 'idle' }
  }

  /**
   * 等用户的这段时间（work）把线程标成在等，等完改回来。同一种事有几件在等时，最后一件等完才去掉标记。
   * 回合结束时一并清掉（和上游一样），那之后才等完的不再报。
   */
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

  // dsh 的提问请求不带调用号（它默认的提问方式）：在还没有结果的提问调用里找题号对得上、还没被认领的那一个，
  // 认领下来，返回它的条目。同一次请求等工具条目时会反复来找，找到之前不认领任何调用。
  claimQuestion(ids: string[]): any {
    const key = JSON.stringify(ids)
    for (const [id, call] of this.calls) {
      if (call.done || this.claimed.has(id) || !isQuestion(call.item)) continue
      const asked = call.item.arguments.questions.map((question: any) => question.id)
      if (JSON.stringify(asked) !== key) continue
      this.claimed.add(id)
      return call.item
    }
    return undefined
  }

  // 适配器发出提示词前按下一个回合编号先建好回合，随后的 turn/start 事件与它对上。
  expect(notify: Notify): DshTurn {
    const turn = this.begin(this.turnNumber + 1, Date.now(), notify)
    this.expected = true
    return turn
  }

  apply(event: WireEvent, notify: Notify): void {
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      if (this.expected && this.active) this.turnNumber = Math.max(this.turnNumber, data.turn)
      else this.begin(Number(data.turn), event.time, notify)
      this.expected = false
    } else if (event.type === 'user/message') {
      if (data.source?.kind === 'user') this.userMessage(data, notify)
    } else if (event.type === 'assistant/message') this.assistantMessage(data, notify)
    else if (event.type === 'tool/call') this.toolCall(data, event.time, notify)
    else if (event.type === 'tool/result') this.toolResult(data, event.time, notify)
    else if (event.type === 'approval/asked') this.asked.set(data.id, data.callId)
    else if (event.type === 'approval/decided') {
      const call = this.calls.get(this.asked.get(data.id) ?? '')
      if (call && data.outcome === 'rejected') call.declined = true
    } else if (event.type === 'turn/end') this.end(data.reason ?? {}, event.time, notify)
    else if (event.type === 'session/title') this.title(data, notify)
    else if (event.type === 'model/selection') {
      this.thread.model = `${data.provider}/${data.model}`
      this.thread.effort = data.reasoningEffort ?? this.thread.effort
      this.chosen = true
    } else if (event.type === 'request/header') this.requested(data.header?.config)
    // 权限档：dsh 的预设是三个内置的之一时就是它。子代理的预设是 custom（派它时按上级定的沙箱和“一律拒绝”的审批），
    // 这时看沙箱：sandbox/mode 的三种和三个预设同名，内置预设切换时 dsh 也记一条
    else if (event.type === 'permission/preset' || event.type === 'sandbox/mode') {
      const preset = knownPreset(event.type === 'sandbox/mode' ? data.mode : data.preset)
      if (preset) this.thread.preset = preset
    } else if (event.type === 'subagent/catalog') this.catalog(data)
    else if (event.type === 'subagent/descriptor') {
      this.subagent = { mode: subagentMode(data.mode), label: optionalText(data.label) }
      this.hooks.subagent?.(this.thread.id, this.subagent)
    }
    this.thread.updatedAt = Math.max(this.thread.updatedAt, Math.floor(event.time / 1000))
  }

  // 实时增量：条目标识由回合、步、块序号组成，与随后落盘的 assistant/message 一致。
  stream(frame: any, notify: Notify): void {
    if (frame.type === 'start') this.attempt = { turn: frame.turn, step: frame.step }
    const turn = this.active
    const chunk = frame.chunk
    if (frame.type !== 'chunk' || !this.attempt || !turn || !chunk?.text) return
    const id = `a:${this.attempt.turn}:${this.attempt.step}:${chunk.index}`
    if (chunk.type === 'text-delta') {
      const item =
        turn.items.find((entry) => entry.id === id) ??
        this.put(turn, this.message(id, '', false), false, notify)
      item.text += chunk.text
      notify('item/agentMessage/delta', { turnId: turn.id, itemId: id, delta: chunk.text })
    } else if (chunk.type === 'reasoning-delta') {
      const item =
        turn.items.find((entry) => entry.id === id) ??
        this.put(turn, { type: 'reasoning', id, summary: [''], content: [] }, false, notify)
      item.summary[0] += chunk.text
      notify('item/reasoning/summaryTextDelta', {
        turnId: turn.id,
        itemId: id,
        summaryIndex: 0,
        delta: chunk.text,
      })
    }
  }

  // 进程中断等异常情况下由适配器直接收尾。
  fail(message: string, notify: Notify): void {
    this.end({ kind: 'error', message }, Date.now(), notify)
  }

  // dsh 的标题有三种来源。兜底标题（fallback）是头一句话开头的几个词，它自己的模型标题出来之前先顶着，
  // 模型标题没生成成就一直是它：这不是谁起的名字，不当会话的名字。客户端没有名字时显示的是预览，
  // 那才是用户发来的那句话（兜底标题是照交给 dsh 的那一句截的，点了技能的是“/名字”打头）。
  // 另两种是模型起的和用户改的，照旧是名字。
  private title(data: any, notify: Notify): void {
    this.titled = true
    const wanted = this.wanted
    this.wanted = null
    const preview = this.thread.preview.trim()
    if (wanted && data.source?.kind !== 'user' && !(preview && preview.startsWith(wanted.trim()))) {
      this.thread.name = wanted
      notify('thread/name/updated', { threadName: wanted })
      this.hooks.pin?.(wanted)
      return
    }
    if (typeof data.title !== 'string') return
    if (data.source?.kind === 'fallback') {
      this.fallback = data.title
      return
    }
    this.named = data.title
    this.thread.name = data.title
    notify('thread/name/updated', { threadName: this.thread.name })
  }

  // 会话的模型和强度，照 dsh 自己的 modelSelection 投影：next 是下一次请求要用的（选了还没用上的那个，
  // 没有就是上一次请求用的），和 lastUsed 不一样就是选了还没用上。两样都没有的是没选过也没说过话的会话，
  // 模型留空：它到发请求时用 dsh 当时的默认（见 DshServer.selection）。
  selection(value: any): void {
    const next = value?.next ?? value?.lastUsed
    if (!next) return
    this.thread.model = `${next.provider}/${next.model}`
    this.thread.effort = next.reasoningEffort ?? null
    this.chosen =
      JSON.stringify(selectionKey(next)) !== JSON.stringify(selectionKey(value.lastUsed))
  }

  // 一次模型请求的头：这一次实际用的模型和强度，没选过模型的会话到这时才知道用的是哪个。
  // 选了还没用上、这一次用的又不是它的，仍以选的为准（和 dsh 的投影一个算法）。
  private requested(config: any): void {
    if (typeof config?.provider !== 'string' || typeof config?.model !== 'string') return
    const model = `${config.provider}/${config.model}`
    const effort =
      config.reasoningEffort == null ? this.thread.effort : String(config.reasoningEffort)
    if (this.chosen && (model !== this.thread.model || effort !== this.thread.effort)) return
    this.chosen = false
    this.thread.model = model
    this.thread.effort = effort
  }

  private message(id: string, body: string, commentary: boolean): any {
    return {
      type: 'agentMessage',
      id,
      text: body,
      phase: commentary ? 'commentary' : 'final_answer',
      memoryCitation: null,
    }
  }

  private begin(number: number, time: number, notify: Notify): DshTurn {
    if (this.active) this.end({ kind: 'interrupted' }, time, notify)
    this.turnNumber = Math.max(this.turnNumber, number)
    const turn: DshTurn = {
      id: `turn:${number}`,
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
    notify('turn/started', { turn })
    notify('thread/status/changed', { status: this.status() })
    return turn
  }

  private put(turn: DshTurn, item: any, complete: boolean, notify: Notify): any {
    const index = turn.items.findIndex((entry) => entry.id === item.id)
    if (index < 0) {
      turn.items.push(item)
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
    } else turn.items[index] = item
    if (complete) {
      this.open.delete(item.id)
      notify('item/completed', { turnId: turn.id, item })
    }
    return item
  }

  private userMessage(message: any, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const body = text(message.content)
    const clientId = message.source?.rpcId ?? null
    // 回给客户端的是它发来的样子：适配器记着那一份的就用它。dsh 的记录里技能只是一句“/名字”，图片只有附件号。
    // 没记的（记录丢了、记这一份之前发的）照 dsh 的记录来：文字是交给 dsh 的那一句，图片等着按附件号去取。
    let content = clientId === null ? null : (this.hooks.recorded?.(clientId) ?? null)
    if (!content) {
      content = [{ type: 'text', text: body, text_elements: [] }]
      for (const part of Array.isArray(message.content) ? message.content : [])
        if (part?.type === 'image' && typeof part.attachment?.attachmentId === 'string')
          this.unfetched.push({ content, attachmentId: part.attachment.attachmentId })
    }
    // 预览取这句话里用户自己写的字，技能、文件引用、图片不算；一个字都没写的（只点了技能）才用交给 dsh 的那一句。
    if (!this.thread.preview) this.thread.preview = (text(content) || body).slice(0, 200)
    this.put(
      turn,
      { type: 'userMessage', id: `user:${message.id}`, content, clientId },
      true,
      notify,
    )
  }

  private assistantMessage(data: any, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const blocks: any[] = data.message?.content ?? []
    const commentary = blocks.some((block) => block.type === 'tool-call')
    blocks.forEach((block, index) => {
      const id = `a:${data.turn}:${data.step}:${index}`
      if (block.type === 'text' && block.text)
        this.put(turn, this.message(id, block.text, commentary), true, notify)
      else if (block.type === 'reasoning' && block.text)
        this.put(turn, { type: 'reasoning', id, summary: [block.text], content: [] }, true, notify)
    })
    const u = data.usage
    if (!u) return
    const last = {
      totalTokens: u.totalTokens ?? 0,
      inputTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      cachedInputTokens: u.cacheReadTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      reasoningOutputTokens: u.reasoningTokens ?? 0,
    }
    if (!last.totalTokens && !last.inputTokens && !last.outputTokens) return
    for (const key of Object.keys(last) as Array<keyof typeof last>) this.usage[key] += last[key]
    notify('thread/tokenUsage/updated', {
      turnId: turn.id,
      tokenUsage: { total: { ...this.usage }, last, modelContextWindow: this.contextWindow },
    })
  }

  private toolCall(data: any, time: number, notify: Notify): void {
    const turn = this.active
    if (!turn || this.calls.has(data.callId)) return
    const args = parse(data.arguments)
    const item = toolItem(data.callId, String(data.name), args, this.thread, this.hooks.clientTool)
    this.calls.set(data.callId, { item, args, done: false, startedMs: time })
    this.put(turn, item, false, notify)
  }

  // 派了一个子代理：派它的工具调用落盘之后、结果之前，dsh 在派它的会话里记一条 subagent/catalog，
  // 带子代理的会话号（就是它的线程号）、方式和标签。接到还没有子代理的那个派出条目上（标签就是调用时给的 description）
  private catalog(data: any): void {
    const child = optionalText(data.childId)
    if (!child) return
    const label = optionalText(data.label)
    this.hooks.subagent?.(child, { mode: subagentMode(data.mode), label })
    let spawn: any
    for (const call of this.calls.values())
      if (
        !call.done &&
        call.item.type === 'collabAgentToolCall' &&
        call.item.tool === 'spawnAgent' &&
        !call.item.receiverThreadIds.length &&
        (spawn === undefined || call.args.description === label)
      )
        spawn = call.item
    if (!spawn) return
    spawn.receiverThreadIds = [child]
    spawn.agentsStates[child] = { status: 'pendingInit', message: null }
  }

  private toolResult(data: any, time: number, notify: Notify): void {
    const call = this.calls.get(data.message?.toolCallId)
    const turn = this.turns.find((entry) => entry.items.includes(call?.item))
    // dsh 裁剪旧结果时会对同一调用追加替换事件，已完成的调用不再改写。
    if (!call || call.done || !turn) return
    call.done = true
    finishTool(call.item, call.args, data.message, data.meta)
    // 时长取调用与结果两个落盘事件的时间差，实时与回放得到同一个值；文件修改、子代理条目没有这个字段。
    if ('durationMs' in call.item)
      call.item.durationMs = Math.max(0, Math.round(time - call.startedMs))
    // 用户拒绝提权的调用按协议标成 declined，而不是普通的执行失败；依据是落盘的裁决事件，回放时同样成立。
    if (call.declined) declineItem(call.item)
    this.put(turn, call.item, true, notify)
  }

  private end(reason: any, time: number, notify: Notify): void {
    const turn = this.active
    if (!turn) return
    const kind = String(reason.kind ?? 'error')
    turn.status =
      kind === 'completed'
        ? 'completed'
        : kind === 'aborted' || kind === 'interrupted'
          ? 'interrupted'
          : 'failed'
    if (turn.status === 'failed')
      turn.error = {
        message: String(reason.message ?? reason.error?.message ?? `dsh 回合结束：${kind}`),
        codexErrorInfo: null,
        additionalDetails: null,
      }
    for (const item of turn.items) {
      if (!this.open.delete(item.id)) continue
      if (item.status === 'inProgress') item.status = 'failed'
      notify('item/completed', { turnId: turn.id, item })
    }
    turn.completedAt = Math.floor(time / 1000)
    turn.durationMs = Math.max(0, time - (this.startedMs.get(turn.id) ?? time))
    this.active = null
    this.expected = false
    this.attempt = null
    this.approving.clear()
    this.asking.clear()
    notify('turn/completed', { turn })
    notify('thread/status/changed', { status: this.status() })
  }
}
