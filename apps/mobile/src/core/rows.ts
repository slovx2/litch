// 会话视图 → 对话区的行。规矩（对着验证原型里查出来的“飘”和“卡”的原因定的）：
// - 行的标识只由回合、条目、块号决定，流式和定稿之间不变；内容没变的行原样复用同一个对象，单元格不重画。
// - 过程（命令、工具调用、改文件、搜索、说明）连成一组，收起时是一行高度固定的摘要；展开时每一步各是一行，
//   排在摘要的上面（倒置列表里往上长，被点的摘要原地不动）。展开收起只由用户点，回合结束时不自动收起。
// - 每个回合末尾一行状态，从回合开始到结束一直在，只换字不换高度。
// - 行里放条目对象本身（单元格从它取要画的东西），再加上条目里会被原地改掉的那几项（核心对文字、状态是原地改的，
//   对 item.add 是整个换掉）：这样逐项比一遍（sameRow）就知道内容变没变。
import type {
  CommandItem,
  FileChangeItem,
  ItemView,
  NoticeItem,
  SessionView,
  Text,
  TodoStep,
  ToolCallItem,
  TurnView,
  UserAttachment,
  WebSearchItem,
} from '@litch/core'
import { type ChunkState, chunkText, emptyChunks } from './blocks'

export type StepItem = CommandItem | FileChangeItem | ToolCallItem | WebSearchItem | NoticeItem

/** declined：用户或策略拒绝了 */
export type StepState = 'running' | 'done' | 'failed' | 'declined'

export type Row =
  /** 会话最上面一行：从哪个会话分叉出来的 */
  | { type: 'forked'; key: string; from: string }
  | { type: 'user'; key: string; turnId: string; text: string; attachments: UserAttachment[] }
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
      open: boolean
      expanded: boolean
    }
  /** 一组过程的摘要。current：正在跑的那一步说的是什么 */
  | {
      type: 'group'
      key: string
      turnId: string
      count: number
      failed: number
      current: Text | null
      running: boolean
      expanded: boolean
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
  /** 失败的回合带着的原因，排在状态行上面。被打断的回合不画（照桌面端） */
  | { type: 'error'; key: string; text: string }
  | {
      type: 'status'
      key: string
      turnId: string
      status: TurnView['status']
      durationMs: number | null
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
    for (const itemId of turn.itemIds) {
      const item = view.items[itemId]
      if (!item) continue
      if (isStep(item)) {
        group.push(item)
        continue
      }
      flush()
      switch (item.kind) {
        case 'userMessage':
          out.push(
            this.keep({
              type: 'user',
              key: item.id,
              turnId: turn.id,
              text: item.text,
              attachments: item.attachments,
            }),
          )
          break
        case 'agentMessage':
          out.push(
            ...this.markdown(turn.id, item.id, item.text, item.status === 'inProgress', false),
          )
          break
        case 'plan':
          // 计划条目没有自己的状态：回合在跑就当它还在长
          out.push(...this.markdown(turn.id, item.id, item.text, running, true))
          break
        case 'reasoning': {
          const expanded = this.expanded.has(item.id)
          out.push(
            this.keep({
              type: 'reasoning',
              key: item.id,
              turnId: turn.id,
              text: expanded ? item.text.trim() : lastLine(item.text),
              open: item.status === 'inProgress',
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
      }
    }
    flush()
    if (turn.status === 'failed' && turn.error)
      out.push(this.keep({ type: 'error', key: `${turn.id}:error`, text: turn.error }))
    out.push(
      this.keep({
        type: 'status',
        key: `${turn.id}:status`,
        turnId: turn.id,
        status: turn.status,
        durationMs: turn.durationMs,
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
      if (state === 'running') current = labelOf(item)
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
        current,
        running: current !== null,
        expanded,
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
