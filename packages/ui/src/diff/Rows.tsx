// 差异里的一行行怎么画：合并的一行、并排的一行、两段之间“还有多少行没显示”的那一行，和一小批行（一块）。
// 行高在样式里（diff.css 的 --dl），脚本里估高度用的是同一个数（Pane.tsx 的 LINE）。
import type { FileDiff, SpanNode } from '@litch/core'
import { Fragment, memo, type ReactNode, useEffect, useMemo, useReducer } from 'react'
import { useT } from '../app/appearance.ts'
import { cutLine } from '../files/lines.ts'
import { renderSpans } from '../transcript/highlight.tsx'
import { type Cell, cellOf, type DiffRow } from './model.ts'
import { onPaint, paintOf } from './paint.ts'

/** 行号上点了一下。side：旧的那边还是新的那边；extend：按着 Shift，接着上一次点的连成一段 */
export type PickLine = (side: 'old' | 'next', cell: Cell, extend: boolean) => void

/** 一行底下要接着画的东西（批注）。没有就返回 null */
export type RowExtra = (row: DiffRow) => ReactNode

function Code({ cell, nodes }: { cell: Cell; nodes: SpanNode[] | undefined }) {
  const t = useT()
  const cut = cutLine(cell.text)
  if (cut.hidden === 0) return nodes ? renderSpans(nodes) : cell.text || '​'
  return (
    <>
      {cut.text}
      <span className="dr-cut">{t('files.view.lineCut', { n: cut.hidden })}</span>
    </>
  )
}

function Num({
  cell,
  side,
  onPick,
  marked,
}: {
  cell: Cell | null
  side: 'old' | 'next'
  onPick: PickLine | null
  marked: boolean
}) {
  if (!cell) return <span className="dn" />
  if (!onPick) return <span className="dn">{cell.no}</span>
  return (
    <button
      type="button"
      className={marked ? 'dn dn-pick on' : 'dn dn-pick'}
      data-side={side}
      data-no={cell.no}
      tabIndex={-1}
      onClick={(event) => onPick(side, cell, event.shiftKey)}
    >
      {cell.no}
    </button>
  )
}

const SIGN = { ' ': '', '+': '+', '-': '−' } as const
const TONE = { ' ': 'same', '+': 'add', '-': 'del' } as const

interface RowProps {
  row: DiffRow
  oldNodes: SpanNode[] | undefined
  nextNodes: SpanNode[] | undefined
  onPick: PickLine | null
  onReveal: ((gap: number) => void) | null
  /** 这一行在一段选中的行里（要批注的那几行）：'old'、'next' 或者没有 */
  marked: 'old' | 'next' | null
}

const Row = memo(function Row({ row, oldNodes, nextNodes, onPick, onReveal, marked }: RowProps) {
  const t = useT()
  if (row.kind === 'gap') {
    // 展不开、也不知道隔了多少行的（本回合的差异的末尾）：没什么可说的，不画
    if (!onReveal && row.hidden === null && !row.section) return null
    return (
      <div className="dr gap" data-gap={row.gap}>
        {onReveal ? (
          <button type="button" className="dr-more" onClick={() => onReveal(row.gap)}>
            {row.hidden === null ? t('diffs.expand') : t('diffs.expandN', { n: row.hidden })}
          </button>
        ) : (
          <span className="dr-more">
            {row.hidden === null ? '' : t('diffs.hiddenN', { n: row.hidden })}
          </span>
        )}
        {row.section ? <span className="dr-sec">{row.section}</span> : null}
      </div>
    )
  }
  if (row.kind === 'eol') {
    return (
      <div className="dr eol">{t(row.side === 'old' ? 'diffs.noEolOld' : 'diffs.noEolNew')}</div>
    )
  }
  if (row.kind === 'line') {
    const cell = row.next ?? row.old
    return (
      <div className={`dr one ${TONE[row.sign]}`} data-old={row.old?.no} data-new={row.next?.no}>
        <Num
          cell={row.old}
          side="old"
          onPick={row.sign === '-' ? onPick : null}
          marked={marked === 'old'}
        />
        <Num
          cell={row.next}
          side="next"
          onPick={row.sign === '-' ? null : onPick}
          marked={marked === 'next'}
        />
        <span className="ds">{SIGN[row.sign]}</span>
        <span className="dc">
          {cell ? <Code cell={cell} nodes={row.next ? nextNodes : oldNodes} /> : null}
        </span>
      </div>
    )
  }
  const changed = row.sign === '~'
  return (
    <div className="dr two" data-old={row.old?.no} data-new={row.next?.no}>
      <Num cell={row.old} side="old" onPick={changed ? onPick : null} marked={marked === 'old'} />
      <span className={row.old ? (changed ? 'dc del' : 'dc') : 'dc void'}>
        {row.old ? <Code cell={row.old} nodes={oldNodes} /> : null}
      </span>
      <Num
        cell={row.next}
        side="next"
        onPick={row.next ? onPick : null}
        marked={marked === 'next'}
      />
      <span className={row.next ? (changed ? 'dc add' : 'dc') : 'dc void'}>
        {row.next ? <Code cell={row.next} nodes={nextNodes} /> : null}
      </span>
    </div>
  )
})

export interface Selected {
  side: 'old' | 'next'
  from: number
  to: number
}

const markOf = (row: DiffRow, selected: Selected | null): 'old' | 'next' | null => {
  if (!selected) return null
  const cell = cellOf(row, selected.side)
  return cell && cell.no >= selected.from && cell.no <= selected.to ? selected.side : null
}

/** 一小批行。上色的结果到了，只有它自己重画（里面的行各自按内容比，没变的不动） */
export const Chunk = memo(function Chunk({
  path,
  file,
  rows,
  onPick,
  onReveal,
  selected,
  extraFor,
}: {
  path: string
  file: FileDiff
  rows: readonly DiffRow[]
  onPick: ((path: string, ...args: Parameters<PickLine>) => void) | null
  onReveal: ((path: string, gap: number) => void) | null
  selected: Selected | null
  extraFor: ((path: string) => RowExtra | null) | null
}) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onPaint(redraw), [])
  const pick = useMemo<PickLine | null>(
    () => (onPick ? (side, cell, extend) => onPick(path, side, cell, extend) : null),
    [onPick, path],
  )
  const revealGap = useMemo(
    () => (onReveal ? (gap: number) => onReveal(path, gap) : null),
    [onReveal, path],
  )
  const extra = useMemo(() => extraFor?.(path) ?? null, [extraFor, path])
  const painted = paintOf(file)
  return (
    <>
      {rows.map((row) => {
        const old = row.kind === 'line' || row.kind === 'pair' ? row.old : null
        const next = row.kind === 'line' || row.kind === 'pair' ? row.next : null
        return (
          <Fragment key={row.id}>
            <Row
              row={row}
              oldNodes={old ? painted?.old[old.at] : undefined}
              nextNodes={next ? painted?.next[next.at] : undefined}
              onPick={pick}
              onReveal={revealGap}
              marked={markOf(row, selected)}
            />
            {extra?.(row)}
          </Fragment>
        )
      })}
    </>
  )
})
