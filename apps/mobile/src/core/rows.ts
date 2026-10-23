// 会话视图 → 对话区的行。规矩（对着验证原型里查出来的“飘”和“卡”的原因定的）：
// - 行的标识只由回合、条目、块号决定，流式和定稿之间不变；内容没变的行原样复用同一个对象，单元格不重画。
// - 过程（命令、工具调用、改文件、搜索、说明）连成一组，收起时是一行高度固定的摘要；展开时每一步各是一行，
//   排在摘要的上面（倒置列表里往上长，被点的摘要原地不动）。展开收起只由用户点，回合结束时不自动收起。
// - 每个回合末尾一行状态，从回合开始到结束一直在，只换字不换高度。回合在跑时写“{name} 正在工作”和已用的时间，只在正文出字、等人答复时留空（workingShown）。
// - 建议任务的卡片（收尾带的、start 提的）和收尾留的问题排在回合最下方（回答下面、状态行上面），过程里调用的位置只留一步；
//   offer 卡挂在回合中间等人选，不挪。没字的思考不画。
// - 行里放条目对象本身（单元格从它取要画的东西），再加上条目里会被原地改掉的那几项（核心对文字、状态是原地改的，
//   对 item.add 是整个换掉）：这样逐项比一遍（sameRow）就知道内容变没变。
import type {
  CommandItem,
  CompactionItem,
  FileChangeItem,
  ItemView,
  NoticeItem,
  PeerView,
  SessionNoteView,
  SessionProposalView,
  SessionView,
  SpawnedView,
  Text,
  TodoStep,
  ToolCallItem,
  TurnOrigin,
  TurnView,
  UserAttachment,
  WebSearchItem,
} from '@litch/core'
import { goalReachedIn, spanOf, thoughtShown, workingShown } from '@litch/core'
import { cardsOf, eventKind, handOffOf, isOfferCall, isWrapUp } from '../detail/proposals/logic'
import { type ChunkState, chunkText, emptyChunks } from './blocks'

export type StepItem = CommandItem | FileChangeItem | ToolCallItem | WebSearchItem | NoticeItem

/** declined：用户或策略拒绝了 */
export type StepState = 'running' | 'done' | 'failed' | 'declined'

export type Row =
  /** 会话最上面一行：从哪个会话分叉出来的 */
  | { type: 'forked'; key: string; from: string }
  | {
      type: 'user'
      key: string
      turnId: string
      text: string
      attachments: UserAttachment[]
      /** 别的会话发来的消息（peerMessages 扩展）：气泡上面写是谁发来的 */
      peer?: PeerView
    }
  /**
   * 不是用户发起的回合开头那一行（后台任务跑完后 harness 自己接着做的……），放在用户气泡的位置。
   * 叫醒它的任务由单元格对着后台集合找（startedAt 用来找）
   */
  | {
      type: 'origin'
      key: string
      turnId: string
      origin: Exclude<TurnOrigin, 'user'>
      startedAt: number | null
    }
  /**
   * 设备进程注入在用户消息开头的那一段（<litch-session-event>）：子会话的回报、唤醒、没调收尾时的提醒。
   * 画成一条轻的提示，不画成用户说的话
   */
  | {
      type: 'event'
      key: string
      turnId: string
      kind: 'notes' | 'wake' | 'remind'
      notes: SessionNoteView[]
    }
  /**
   * 一张提案卡（建议任务）：收尾调用带的一条建议，或者 litch_sessions.start 降成的提案。一条调用几张卡就几行。
   * proposal 为 null：start 的结果里有提案号、列表里还没有它，照调用时给的（spawned）画。
   * offer：start 带 initiation offer 的那张（“新会话 / 在这里做”）
   */
  | {
      type: 'proposal'
      key: string
      turnId: string
      itemId: string
      proposal: SessionProposalView | null
      spawned: SpawnedView | null
      offer: boolean
    }
  /**
   * 收尾（wrap_up）留给用户的问题和回复按钮，排在回合最下方的卡片前面。能不能答由单元格对着会话的最后一个回合算
   */
  | {
      type: 'wrapAsk'
      key: string
      turnId: string
      itemId: string
      ask: string
      actions: readonly { label: string; message?: string }[]
    }
  /**
   * litch_sessions.hand_off：做到一半的任务交给了分叉会话。threadId 是起出来的那个，还没有结果是 null。
   * running：调用还没完
   */
  | {
      type: 'handoff'
      key: string
      turnId: string
      itemId: string
      title: string
      threadId: string | null
      running: boolean
    }
  /**
   * 回答或计划的一块。open：这一块还在长；live：这条回答还在流式（它的块都算，哪怕最后一块刚好封了口）；
   * plan：计划条目，first 的那一块上面写“计划”
   */
  | {
      type: 'md'
      key: string
      turnId: string
      itemId: string
      text: string
      open: boolean
      live: boolean
      plan: boolean
      first: boolean
    }
  /** 收起时只有最后一行字，点开是全文 */
  | {
      type: 'reasoning'
      key: string
      turnId: string
      text: string
      expanded: boolean
    }
  /**
   * 一组过程的摘要。current：正在跑的那一步说的是什么（回合在跑时才有：回合结束后还 inProgress 的是后台命令）。
   * ids：这一组各步的条目标识（空格隔开），回合结束了（ended）时单元格拿它对着后台集合数还有几个在跑
   */
  | {
      type: 'group'
      key: string
      turnId: string
      count: number
      failed: number
      /** 这一组从第一条开始到最后一条结束用了多久（条目上记的 span）。没记过是 null */
      durationMs: number | null
      current: Text | null
      running: boolean
      expanded: boolean
      ids: string
      ended: boolean
    }
  /** 展开的一组里的一步。output、tail、exitCode、durationMs 是命令条目上会原地变的几项 */
  | {
      type: 'step'
      key: string
      turnId: string
      item: StepItem
      state: StepState
      output: string
      tail: string
      exitCode: number | null
      durationMs: number | null
      expanded: boolean
    }
  | { type: 'todo'; key: string; note: string | null; steps: TodoStep[]; running: boolean }
  | { type: 'notice'; key: string; label: Text; detail: string | null }
  /** 上下文压缩：一条分隔线，不进过程组（照桌面端）。startedAt：这边看着它开始的时刻，压久了多写一句 */
  | {
      type: 'compaction'
      key: string
      status: CompactionItem['status']
      source: CompactionItem['source']
      startedAt: number | null
    }
  /**
   * 达成目标的那一轮：最后一条回答下面一行“目标已达成 · 用时 N”（核心的 goalReachedIn 定写不写）。
   * ms 是目标一共用了多久
   */
  | { type: 'goalReached'; key: string; turnId: string; ms: number; objective: string }
  /** 失败的回合带着的原因，排在状态行上面。被打断的回合不画（照桌面端） */
  | { type: 'error'; key: string; text: string }
  | {
      type: 'status'
      key: string
      turnId: string
      status: TurnView['status']
      durationMs: number | null
      /** 回合开始的时刻：“正在工作”后面写已经用了多久。对面没给是 null */
      startedAt: number | null
      /** 回合在跑、没有正文在出字、没有等人答复（核心的 workingShown）：这时写“正在工作”，别的时候留空 */
      working: boolean
    }

interface ItemCache {
  chunks: ChunkState
  text: string | null
}

const STEP_KINDS = new Set<ItemView['kind']>([
  'command',
  'fileChange',
  'toolCall',
  'webSearch',
  'notice',
])

const isStep = (item: ItemView): item is StepItem => STEP_KINDS.has(item.kind)

const NO_ACTIONS: readonly { label: string; message?: string }[] = []

/** 一个会话的行。跟着视图一起活，记着各条目切到哪了、上一次给出的行对象 */
export class RowBuilder {
  private readonly items = new Map<string, ItemCache>()
  private readonly rows = new Map<string, Row>()
  private readonly turnRows = new Map<string, Row[]>()
  /** 展开着的：过程组（组的键）、某一步（步的键）、思考（条目标识） */
  readonly expanded = new Set<string>()

  /** 重算这些回合的行，其余的照旧；返回从旧到新的全部行 */
  build(view: SessionView, dirtyTurns: Set<string> | 'all'): Row[] {
    const all: Row[] = []
    if (view.forkedFrom)
      all.push(this.keep({ type: 'forked', key: 'forked', from: view.forkedFrom }))
    const alive = new Set<string>()
    for (const turn of view.turns) {
      alive.add(turn.id)
      let rows = this.turnRows.get(turn.id)
      if (!rows || dirtyTurns === 'all' || dirtyTurns.has(turn.id)) {
        rows = this.buildTurn(view, turn)
        this.turnRows.set(turn.id, rows)
      }
      for (const row of rows) all.push(row)
    }
    for (const id of [...this.turnRows.keys()]) if (!alive.has(id)) this.turnRows.delete(id)
    return all
  }

  private buildTurn(view: SessionView, turn: TurnView): Row[] {
    const out: Row[] = []
    const running = turn.status === 'running'
    let group: StepItem[] = []
    const flush = () => {
      if (group.length === 0) return
      const steps = group
      group = []
      // 只有说明的一组不折叠：一两行字，折起来反而要多点一下（照桌面端）
      if (steps.every((item) => item.kind === 'notice')) {
        for (const item of steps) out.push(this.notice(item as NoticeItem))
        return
      }
      this.pushGroup(out, turn, steps)
    }
    // 别的会话发来消息开的回合：开头那条消息自己写着来源，不再另写一行（照桌面端）
    if (turn.origin && turn.origin !== 'peer')
      out.push(
        this.keep({
          type: 'origin',
          key: `${turn.id}:origin`,
          turnId: turn.id,
          origin: turn.origin,
          startedAt: turn.startedAt,
        }),
      )
    const first = turn.itemIds[0] ? view.items[turn.itemIds[0]] : undefined
    // 提醒收尾的回合只是补调一次收尾：模型顺口说的“好的”不画（手机上回答没有折叠处），建议的卡片照样画
    const remind = first?.kind === 'userMessage' && first.event?.kind === 'remind'
    /** 回合最下方的收尾区：收尾留的问题（最后一个），和这一回合的建议卡片 */
    let tailAsk: Row | null = null
    const tailCards: Row[] = []
    /** 最后一条回答的末尾在 out 里的位置：目标达成那一句插在这里 */
    let answerEnd = -1
    for (const itemId of turn.itemIds) {
      const item = view.items[itemId]
      if (!item) continue
      if (remind && item.kind === 'agentMessage') continue
      const cards = item.kind === 'toolCall' ? cardsOf(item, view.proposals) : null
      if (cards && item.kind === 'toolCall') {
        const offer = isOfferCall(item)
        const ask = item.wrapUp?.ask
        // 没带建议、也没留问题的收尾不画，也不把前后两段过程拆开
        if (cards.length === 0 && !ask) continue
        const rows = cards.map((proposal) =>
          this.keep<Row>({
            type: 'proposal',
            key: `${item.id}:${proposal?.id ?? 'call'}`,
            turnId: turn.id,
            itemId: item.id,
            proposal,
            spawned: item.spawned ?? null,
            offer,
          }),
        )
        // offer 卡挂在回合中间等人选，不挪
        if (offer) {
          flush()
          out.push(...rows)
          continue
        }
        // 建议任务、收尾的问题：过程里只留一步，卡片和问题排到回合最下方。
        // 收尾带的等回合结束再排：先收尾、再写回答，收到就排的话卡片比回答先出来（中途 start 的提案照旧）
        group.push(item)
        if (running && isWrapUp(item)) continue
        tailCards.push(...rows)
        if (ask)
          tailAsk = this.keep({
            type: 'wrapAsk',
            key: `${item.id}:ask`,
            turnId: turn.id,
            itemId: item.id,
            ask,
            actions: item.wrapUp?.actions ?? NO_ACTIONS,
          })
        continue
      }
      const handOff = item.kind === 'toolCall' ? handOffOf(item) : null
      if (handOff && item.kind === 'toolCall') {
        flush()
        out.push(
          this.keep({
            type: 'handoff',
            key: `${item.id}:handoff`,
            turnId: turn.id,
            itemId: item.id,
            title: handOff.title,
            threadId: handOff.threadId,
            running: item.status === 'inProgress',
          }),
        )
        continue
      }
      if (isStep(item)) {
        group.push(item)
        continue
      }
      flush()
      switch (item.kind) {
        case 'userMessage':
          if (item.event)
            out.push(
              this.keep({
                type: 'event',
                key: `${item.id}:event`,
                turnId: turn.id,
                kind: eventKind(item.event),
                notes: item.event.notes,
              }),
            )
          // 唤醒、提醒的回合没有用户自己说的话：只有上面那条提示
          if (item.text || item.attachments.length > 0 || !item.event)
            out.push(
              this.keep({
                type: 'user',
                key: item.id,
                turnId: turn.id,
                text: item.text,
                attachments: item.attachments,
                ...(item.peer ? { peer: item.peer } : {}),
              }),
            )
          break
        case 'agentMessage':
          out.push(
            ...this.markdown(turn.id, item.id, item.text, item.status === 'inProgress', false),
          )
          answerEnd = out.length
          break
        case 'plan':
          // 计划条目没有自己的状态：回合在跑就当它还在长
          out.push(...this.markdown(turn.id, item.id, item.text, running, true))
          break
        case 'reasoning': {
          // 没有可显示的字（引擎只给了加密的、空的推理）：想完了就不画
          if (!thoughtShown(item)) break
          const expanded = this.expanded.has(item.id)
          out.push(
            this.keep({
              type: 'reasoning',
              key: item.id,
              turnId: turn.id,
              text: expanded ? item.text.trim() : lastLine(item.text),
              expanded,
            }),
          )
          break
        }
        case 'todo':
          out.push(
            this.keep({ type: 'todo', key: item.id, note: item.note, steps: item.steps, running }),
          )
          break
        case 'compaction':
          out.push(
            this.keep({
              type: 'compaction',
              key: item.id,
              status: item.status,
              source: item.source,
              startedAt: item.span?.from ?? null,
            }),
          )
          break
      }
    }
    flush()
    const reachedMs = goalReachedIn(view.goalReached, turn)
    if (reachedMs !== null && view.goalReached && answerEnd >= 0)
      out.splice(
        answerEnd,
        0,
        this.keep({
          type: 'goalReached',
          key: `${turn.id}:goal`,
          turnId: turn.id,
          ms: reachedMs,
          objective: view.goalReached.objective,
        }),
      )
    if (tailAsk) out.push(tailAsk)
    out.push(...tailCards)
    if (turn.status === 'failed' && turn.error)
      out.push(this.keep({ type: 'error', key: `${turn.id}:error`, text: turn.error }))
    out.push(
      this.keep({
        type: 'status',
        key: `${turn.id}:status`,
        turnId: turn.id,
        status: turn.status,
        durationMs: turn.durationMs,
        startedAt: turn.startedAt,
        working:
          running &&
          workingShown(
            running,
            turn.itemIds.map((id) => view.items[id]),
            view.requests.length,
          ),
      }),
    )
    return out
  }

  /** 一组过程：展开时先是每一步（从旧到新），最后是摘要，倒置之后摘要在最下面 */
  private pushGroup(out: Row[], turn: TurnView, steps: StepItem[]): void {
    const key = `${turn.id}:p:${steps[0]?.id}`
    const expanded = this.expanded.has(key)
    let failed = 0
    let current: Text | null = null
    for (const item of steps) {
      const state = stateOf(item)
      if (state === 'failed') failed++
      if (state === 'running' && turn.status === 'running') current = labelOf(item)
      if (!expanded) continue
      const command = item.kind === 'command' ? item : null
      const stepKey = `s:${item.id}`
      out.push(
        this.keep({
          type: 'step',
          key: stepKey,
          turnId: turn.id,
          item,
          state,
          output: command?.output ?? '',
          tail: command?.elided?.tail ?? '',
          exitCode: command?.exitCode ?? null,
          durationMs: command?.durationMs ?? (item.kind === 'toolCall' ? item.durationMs : null),
          expanded: this.expanded.has(stepKey),
        }),
      )
    }
    out.push(
      this.keep({
        type: 'group',
        key,
        turnId: turn.id,
        count: steps.length,
        failed,
        durationMs: spanOf(steps),
        current,
        running: current !== null,
        expanded,
        ids: steps.map((item) => item.id).join(' '),
        ended: turn.status !== 'running',
      }),
    )
  }

  private notice(item: NoticeItem): Row {
    return this.keep({ type: 'notice', key: item.id, label: item.label, detail: item.detail })
  }

  private markdown(
    turnId: string,
    itemId: string,
    text: string,
    open: boolean,
    plan: boolean,
  ): Row[] {
    let cache = this.items.get(itemId)
    if (!cache) {
      cache = { chunks: emptyChunks(), text: null }
      this.items.set(itemId, cache)
    }
    const chunks = chunkText(cache.chunks, text, cache.text, open)
    cache.text = text
    return chunks.map((chunk) =>
      this.keep({
        type: 'md',
        key: `${itemId}:${chunk.index}`,
        turnId,
        itemId,
        text: chunk.text,
        open: chunk.open,
        live: open,
        plan,
        first: chunk.index === 0,
      }),
    )
  }

  /** 和上一次给出的同一个键的行一样，就还用上一次的对象 */
  private keep<R extends Row>(row: R): R {
    const previous = this.rows.get(row.key)
    if (previous && sameRow(previous, row)) return previous as R
    this.rows.set(row.key, row)
    return row
  }
}

/** 同一种行的各项逐个比：字和数比值，条目、数组比引用（核心换掉条目时它们才换） */
function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type) return false
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  for (const key in left) if (left[key] !== right[key]) return false
  return true
}

function stateOf(item: StepItem): StepState {
  if (item.kind === 'webSearch' || item.kind === 'notice') return 'done'
  switch (item.status) {
    case 'inProgress':
      return 'running'
    case 'completed':
      // 命令跑完了但退出码不是 0，也算没成
      return item.kind === 'command' && item.exitCode !== null && item.exitCode !== 0
        ? 'failed'
        : 'done'
    case 'declined':
      return 'declined'
    default:
      return 'failed'
  }
}

/** 一步说的是什么：摘要上“正在运行”后面那段 */
export function labelOf(item: StepItem): Text {
  switch (item.kind) {
    case 'command':
      return item.command
    case 'fileChange':
      return item.changes.map((change) => change.path).join(', ')
    case 'toolCall':
      return item.tool
    case 'webSearch':
      return item.query
    case 'notice':
      return item.label
  }
}

const lastLine = (text: string): string => {
  const lines = text.trim().split('\n')
  return lines[lines.length - 1] ?? ''
}
