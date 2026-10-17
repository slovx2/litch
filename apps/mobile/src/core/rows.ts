// 会话视图 → 对话区的行。规矩（对着调研报告第 2.1 节的根因定的）：
// - 行的标识只由回合、条目、块号决定，流式和定稿之间不变（S2）；内容没变的行原样复用同一个对象，单元格不重画。
// - 过程（命令、工具调用、改文件、搜索、待办）连成一组，收起时是一行高度固定的摘要；
//   展开收起只由用户点，回合结束时不自动收起（S3）。
// - 每个回合末尾一行状态，从回合开始到结束一直在，只换字不换高度（S4）。
import type { ItemView, SessionView, TurnView } from '../../../../packages/core/src/index.mts'
import { type ChunkState, chunkText, emptyChunks } from './blocks'

export type Row =
  | { type: 'user'; key: string; text: string }
  /** open：这一块还在长；live：这条回答还在流式（它的块都算，哪怕最后一块刚好封了口） */
  | { type: 'md'; key: string; text: string; open: boolean; live: boolean }
  | { type: 'reasoning'; key: string; text: string; open: boolean }
  | { type: 'process'; key: string; steps: Step[]; expanded: boolean; running: boolean }
  | { type: 'status'; key: string; status: TurnView['status']; durationMs: number | null; error: string | null }

export interface Step {
  id: string
  label: string
  /** 命令输出的最后几行；别的是空 */
  detail: string
  state: 'running' | 'done' | 'failed'
}

interface ItemCache {
  chunks: ChunkState
  text: string | null
}

/** 一个会话的行。跟着视图一起活，记着各条目切到哪了、上一次给出的行对象 */
export class RowBuilder {
  private readonly items = new Map<string, ItemCache>()
  private readonly rows = new Map<string, Row>()
  private readonly turnRows = new Map<string, Row[]>()
  readonly expanded = new Set<string>()

  /** 重算这些回合的行，其余的照旧；返回从旧到新的全部行 */
  build(view: SessionView, dirtyTurns: Set<string> | 'all'): Row[] {
    const all: Row[] = []
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
    let group: Step[] | null = null
    let groupKey = ''
    const flush = () => {
      if (!group) return
      const running = group.some((step) => step.state === 'running')
      out.push(this.keep({ type: 'process', key: groupKey, steps: group, expanded: this.expanded.has(groupKey), running }))
      group = null
    }
    for (const itemId of turn.itemIds) {
      const item = view.items[itemId]
      if (!item) continue
      const step = stepOf(item)
      if (step) {
        if (!group) {
          group = []
          groupKey = `${turn.id}:p:${item.id}`
        }
        group.push(step)
        continue
      }
      flush()
      if (item.kind === 'userMessage') out.push(this.keep({ type: 'user', key: item.id, text: item.text }))
      else if (item.kind === 'agentMessage') out.push(...this.markdown(item.id, item.text, item.status === 'inProgress'))
      else if (item.kind === 'reasoning') {
        out.push(this.keep({ type: 'reasoning', key: item.id, text: lastLine(item.text), open: item.status === 'inProgress' }))
      } else if (item.kind === 'plan') out.push(...this.markdown(item.id, item.text, false))
    }
    flush()
    out.push(
      this.keep({
        type: 'status',
        key: `${turn.id}:status`,
        status: turn.status,
        durationMs: turn.durationMs,
        error: turn.error,
      }),
    )
    return out
  }

  private markdown(itemId: string, text: string, open: boolean): Row[] {
    let cache = this.items.get(itemId)
    if (!cache) {
      cache = { chunks: emptyChunks(), text: null }
      this.items.set(itemId, cache)
    }
    const chunks = chunkText(cache.chunks, text, cache.text, open)
    cache.text = text
    return chunks.map((chunk) =>
      this.keep({ type: 'md', key: `${itemId}:${chunk.index}`, text: chunk.text, open: chunk.open, live: open }),
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

function sameRow(a: Row, b: Row): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'user':
      return a.text === (b as typeof a).text
    case 'md':
      return a.text === (b as typeof a).text && a.open === (b as typeof a).open && a.live === (b as typeof a).live
    case 'reasoning':
      return a.text === (b as typeof a).text && a.open === (b as typeof a).open
    case 'status': {
      const other = b as typeof a
      return a.status === other.status && a.durationMs === other.durationMs && a.error === other.error
    }
    case 'process': {
      const other = b as typeof a
      if (a.expanded !== other.expanded || a.running !== other.running) return false
      if (a.steps.length !== other.steps.length) return false
      return a.steps.every((step, index) => {
        const next = other.steps[index]
        return next && step.label === next.label && step.state === next.state && step.detail === next.detail
      })
    }
  }
}

function stepOf(item: ItemView): Step | null {
  const state = (status: string): Step['state'] =>
    status === 'inProgress' ? 'running' : status === 'completed' ? 'done' : 'failed'
  switch (item.kind) {
    case 'command':
      return { id: item.id, label: item.command, detail: tailLines(item.output, 6), state: state(item.status) }
    case 'toolCall':
      return { id: item.id, label: typeof item.tool === 'string' ? item.tool : item.tool.key, detail: '', state: state(item.status) }
    case 'fileChange':
      return {
        id: item.id,
        label: item.changes.map((change) => change.path).join(', '),
        detail: '',
        state: state(item.status),
      }
    case 'webSearch':
      return { id: item.id, label: `搜索：${item.query}`, detail: '', state: 'done' }
    case 'todo':
      return { id: item.id, label: `待办 ${item.steps.length} 项`, detail: '', state: 'done' }
    case 'notice':
      return { id: item.id, label: typeof item.label === 'string' ? item.label : item.label.key, detail: '', state: 'done' }
    default:
      return null
  }
}

const lastLine = (text: string): string => {
  const lines = text.trim().split('\n')
  return lines[lines.length - 1] ?? ''
}

const tailLines = (text: string, count: number): string => text.replace(/\s+$/, '').split('\n').slice(-count).join('\n')
