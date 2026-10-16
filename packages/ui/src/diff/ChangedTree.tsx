// 变了的文件按目录排成的树：每行一个状态记号、文件名、增删行数，别的（完整路径、原来的名字、暂存了没有）
// 在鼠标移上去的说明里。上面一个框筛文件。行一样高，只画看得见的。
import type { DiffEntry, DiffStatus } from '@litch/core'
import { memo, useEffect, useMemo } from 'react'
import { useT } from '../app/appearance.ts'
import { Caret } from '../app/icons.tsx'
import { useVirtual } from '../files/virtual.ts'
import type { Translator } from '../i18n/index.ts'
import { type TreeRow, treeRows } from './model.ts'

/** 一行多高，像素。样式里要和它一样（diff.css 的 --dt-row） */
export const TREE_ROW = 24

/** 状态记号上的字 */
export const MARK: Record<DiffStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  typeChanged: 'T',
  conflicted: '!',
}

/** 鼠标移上去的说明：路径、状态、暂存了没有、原来的名字、权限 */
export function entryTip(entry: DiffEntry, t: Translator, git: boolean): string {
  const lines = [entry.path, t(`diffs.status.${entry.status}`)]
  if (entry.from) lines.push(t('diffs.from', { path: entry.from }))
  if (entry.mode) lines.push(t('diffs.mode', { from: entry.mode.from, to: entry.mode.to }))
  if (git && entry.status !== 'untracked') {
    lines.push(
      t(
        entry.staged && entry.unstaged
          ? 'diffs.partlyStaged'
          : entry.staged
            ? 'diffs.staged'
            : 'diffs.unstaged',
      ),
    )
  }
  return lines.join('\n')
}

export function Counts({ entry }: { entry: Pick<DiffEntry, 'added' | 'removed' | 'binary'> }) {
  if (entry.added === null || entry.removed === null) return null
  return (
    <span className="dcount">
      {entry.added > 0 ? <i className="add">+{entry.added}</i> : null}
      {entry.removed > 0 ? <i className="del">−{entry.removed}</i> : null}
    </span>
  )
}

const Row = memo(function Row({
  row,
  picked,
  tip,
  onPick,
  onToggle,
}: {
  row: TreeRow
  picked: boolean
  tip: string
  onPick(path: string): void
  onToggle(path: string): void
}) {
  const indent = { paddingLeft: 6 + row.depth * 12 }
  if (row.kind === 'dir') {
    return (
      <button
        type="button"
        className="dt-row"
        data-kind="dir"
        style={indent}
        aria-expanded={row.open}
        data-path={row.path}
        onClick={() => onToggle(row.path)}
      >
        <Caret />
        <span className="dt-name">{row.name}</span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="dt-row"
      data-kind="file"
      style={indent}
      aria-current={picked}
      data-path={row.path}
      data-status={row.entry.status}
      title={tip}
      onClick={() => onPick(row.path)}
    >
      <span className={`dmark ${row.entry.status}`}>{MARK[row.entry.status]}</span>
      <span className="dt-name">{row.name}</span>
      <Counts entry={row.entry} />
    </button>
  )
})

export function ChangedTree({
  entries,
  query,
  closed,
  picked,
  git,
  onQuery,
  onPick,
  onToggle,
}: {
  entries: readonly DiffEntry[]
  query: string
  closed: ReadonlySet<string>
  picked: string | null
  /** 是 git 的差异（说明里才有“暂存了没有”） */
  git: boolean
  onQuery(query: string): void
  onPick(path: string): void
  onToggle(path: string): void
}) {
  const t = useT()
  const rows = useMemo(() => treeRows(entries, query, closed), [entries, query, closed])
  const virtual = useVirtual(rows.length, TREE_ROW)
  const { show } = virtual

  // 选中的换了（滚内容滚到了别的文件、别处要定位）：树跟着把它露出来
  // biome-ignore lint/correctness/useExhaustiveDependencies: rows 变了位置也可能变，但只在选中的换了的时候才滚
  useEffect(() => {
    if (picked === null) return
    const index = rows.findIndex((row) => row.kind === 'file' && row.path === picked)
    if (index >= 0) show(index)
  }, [picked, show])

  return (
    <div className="dt">
      <div className="dt-tools">
        <input
          className="dt-search"
          type="search"
          data-side-focus
          value={query}
          placeholder={t('diffs.search')}
          aria-label={t('diffs.search')}
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || query === '') return
            event.stopPropagation()
            onQuery('')
          }}
        />
      </div>
      <div
        className="dt-list"
        ref={virtual.scroller}
        role="tree"
        aria-label={t('diffs.tree')}
        data-rows={rows.length}
        onScroll={virtual.onScroll}
      >
        {rows.length === 0 && query.trim() ? (
          <div className="dt-none dim">{t('diffs.search.none')}</div>
        ) : null}
        <div className="dt-pad" style={{ height: rows.length * TREE_ROW }}>
          <div
            className="dt-win"
            style={{ transform: `translateY(${virtual.first * TREE_ROW}px)` }}
          >
            {rows.slice(virtual.first, virtual.last).map((row) => (
              <Row
                key={`${row.kind}:${row.path}`}
                row={row}
                picked={row.kind === 'file' && row.path === picked}
                tip={row.kind === 'file' ? entryTip(row.entry, t, git) : ''}
                onPick={onPick}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
