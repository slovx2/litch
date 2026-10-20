// 文件树。行是核心摊平好了给的（数据副本里的 files:…:rows），这里只画看得见的那几十行：
// 几万个条目的目录展开了，页面上也只有一屏的元素。
// 整棵树是一个能拿焦点的控件：上下键换行，左右键收展，空格预览，回车固定打开（规矩在 nav.ts）。
import { type FileRow, type FileTreeState, keys } from '@litch/core'
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Caret, Icon } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { selectable, treeMove } from './nav.ts'
import {
  clearReveal,
  openFile,
  rememberTreeScroll,
  selectPath,
  treeScrollOf,
  useTreeUi,
} from './state.ts'
import { useVirtual } from './virtual.ts'

/** 一行多高，像素。样式里的行高要和它一样（files.css 的 --ft-row） */
export const ROW_HEIGHT = 24

const NO_ROWS: FileRow[] = []

/** 行在页面上的标识：给 aria-activedescendant 指 */
const domId = (index: number): string => `ft-row-${index}`

export interface RowContext {
  row: FileRow
  x: number
  y: number
}

const Row = memo(function Row({
  row,
  index,
  selected,
  onPick,
  onOpen,
  onMenu,
}: {
  row: FileRow
  index: number
  selected: boolean
  /** detail：这是连着点的第几下 */
  onPick(row: FileRow, detail: number): void
  onOpen(row: FileRow): void
  onMenu(row: FileRow, index: number, event: MouseEvent): void
}) {
  const t = useT()
  const indent = { '--d': row.depth } as CSSProperties
  if (!selectable(row)) {
    // 说明行：跟在它所属的目录下面
    const text =
      row.note?.kind === 'failed'
        ? t('files.tree.failed', { reason: whyNot(row.note.error, t) })
        : row.note?.kind === 'truncated'
          ? t('files.tree.truncated', { n: row.note.hidden })
          : t(row.kind === 'loading' ? 'files.tree.loading' : 'files.tree.empty')
    return (
      <div className="ft-note" data-kind={row.kind} data-path={row.path} style={indent}>
        <span className="ell" title={text}>
          {text}
        </span>
        {row.kind === 'failed' ? (
          <button type="button" className="mini" tabIndex={-1} onClick={() => onPick(row, 1)}>
            {t('files.retry')}
          </button>
        ) : null}
      </div>
    )
  }
  const dir = row.kind === 'dir'
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘操作由整棵树统一接（aria-activedescendant），行自己不拿焦点
    <div
      id={domId(index)}
      className="ft-row"
      role="treeitem"
      tabIndex={-1}
      aria-level={row.depth + 1}
      aria-expanded={dir ? row.expanded : undefined}
      aria-selected={selected}
      data-kind={row.kind}
      data-path={row.path}
      style={indent}
      onClick={(event) => onPick(row, event.detail)}
      onDoubleClick={() => onOpen(row)}
      onContextMenu={(event) => onMenu(row, index, event)}
    >
      {dir ? <Caret /> : <span className="ft-gap" />}
      <Icon name={dir ? (row.expanded ? 'folderOpen' : 'folder') : 'file'} small />
      <span className="ell">{row.name}</span>
    </div>
  )
})

export function FileTree({
  deviceId,
  root,
  uiKey,
  onContext,
}: {
  deviceId: string
  root: string
  uiKey: string
  /** 在一行上要菜单（右键，或者键盘上的菜单键） */
  onContext(context: RowContext): void
}) {
  const { replica } = useServices()
  const t = useT()
  const rows = useKey<FileRow[]>(keys.fileRows(deviceId, root)) ?? NO_ROWS
  const state = useKey<FileTreeState>(keys.fileTree(deviceId, root))
  const ui = useTreeUi(uiKey)
  const virtual = useVirtual(rows.length, ROW_HEIGHT)
  const { scroller, show, onScroll, sync } = virtual
  const selectedIndex = useMemo(
    () => (ui.selected === null ? -1 : rows.findIndex((row) => row.id === ui.selected)),
    [rows, ui.selected],
  )
  /** 最新的行和选中项：键盘和点击的处理函数读它，自己不用跟着每次重建 */
  const latest = useRef({ rows, selectedIndex })
  latest.current = { rows, selectedIndex }

  // 回到这棵树：滚回上次的位置
  const restored = useRef('')
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element || rows.length === 0 || restored.current === uiKey) return
    const restore = () => {
      restored.current = uiKey
      element.scrollTop = treeScrollOf(uiKey)
      sync()
    }
    if (element.clientHeight > 0) {
      restore()
      return
    }
    // 面板收着（侧面板开合按会话记，切到没开过的会话时它不显示）：这时设滚动不起作用，等它露出来再滚
    const observer = new ResizeObserver(() => {
      if (element.clientHeight === 0 || restored.current === uiKey) return
      observer.disconnect()
      restore()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [scroller, sync, uiKey, rows.length])

  // 要露出来的路径（从对话里、从找文件的结果里点开的）：把它上面的各级目录展开，取到了就滚到它那一行
  const seeking = useRef<string | null>(null)
  useEffect(() => {
    const path = ui.reveal
    if (!path) return
    seeking.current = path
    clearReveal(uiKey, path)
    void replica.files.reveal(deviceId, root, path).then((found) => {
      // 没找到（上面的目录不在了）：不滚
      if (!found && seeking.current === path) seeking.current = null
    })
  }, [replica, deviceId, root, uiKey, ui.reveal])
  useLayoutEffect(() => {
    const path = seeking.current
    if (!path) return
    const index = rows.findIndex((row) => row.id === path)
    if (index < 0) return
    seeking.current = null
    show(index, 'nearest')
  }, [rows, show])

  const toggle = useCallback(
    (row: FileRow) => {
      if (row.expanded) replica.files.collapse(deviceId, root, row.path)
      else replica.files.expand(deviceId, root, row.path)
    },
    [replica, deviceId, root],
  )

  const pick = useCallback(
    (row: FileRow, detail: number) => {
      if (row.kind === 'failed') {
        // 没取到的那一层再试一次：收起再展开就会重新去取
        replica.files.collapse(deviceId, root, row.path)
        replica.files.expand(deviceId, root, row.path)
        return
      }
      scroller.current?.focus({ preventScroll: true })
      if (row.kind === 'dir') {
        selectPath(uiKey, row.path)
        // 双击目录不是“展开又收起”：连着点的第二下不算
        if (detail <= 1) toggle(row)
      } else openFile(uiKey, row.path)
    },
    [replica, deviceId, root, uiKey, toggle, scroller],
  )
  const open = useCallback(
    (row: FileRow) => {
      if (row.kind !== 'dir') openFile(uiKey, row.path, { pin: true })
    },
    [uiKey],
  )
  const menu = useCallback(
    (row: FileRow, _index: number, event: MouseEvent) => {
      event.preventDefault()
      selectPath(uiKey, row.path)
      onContext({ row, x: event.clientX, y: event.clientY })
    },
    [uiKey, onContext],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const { rows: list, selectedIndex: at } = latest.current
    // 菜单键、Shift+F10：在选中的那一行上出菜单
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const row = list[at]
      const box = document.getElementById(domId(at))?.getBoundingClientRect()
      if (!row || !box) return
      event.preventDefault()
      onContext({ row, x: box.left + 24, y: box.bottom })
      return
    }
    const height = scroller.current?.clientHeight ?? 0
    const move = treeMove(list, at, event.key, Math.floor(height / ROW_HEIGHT))
    if (!move) return
    event.preventDefault()
    const row = list[move.index]
    if (!row) return
    if (move.do === 'select') {
      selectPath(uiKey, row.path)
      show(move.index)
    } else if (move.do === 'expand') replica.files.expand(deviceId, root, row.path)
    else if (move.do === 'collapse') replica.files.collapse(deviceId, root, row.path)
    else openFile(uiKey, row.path, { pin: move.do === 'open' })
  }

  // 根那一层没取到：整块说明是怎么回事，给一个重试
  if (state?.phase === 'failed') {
    const unsupported = state.error?.code === 'unsupported'
    return (
      <div className="ft-hold" data-hold={state.error?.code ?? 'failed'} role="status">
        <b>{t(unsupported ? 'files.tree.unsupported' : 'files.tree.rootFailed')}</b>
        <span>{state.error ? whyNot(state.error, t) : ''}</span>
        {unsupported ? null : (
          <button
            type="button"
            className="btn"
            data-side-focus
            onClick={() => void replica.files.refresh(deviceId, root)}
          >
            {t('files.retry')}
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="ft-scroll"
      ref={scroller}
      role="tree"
      tabIndex={0}
      data-side-focus
      aria-label={t('files.tree')}
      aria-activedescendant={selectedIndex >= 0 ? domId(selectedIndex) : undefined}
      aria-busy={state?.phase !== 'ready' || state.refreshing}
      data-rows={rows.length}
      data-first={virtual.first}
      data-last={virtual.last}
      onKeyDown={onKeyDown}
      onScroll={() => {
        onScroll()
        const element = scroller.current
        if (element && restored.current === uiKey) rememberTreeScroll(uiKey, element.scrollTop)
      }}
    >
      <div className="ft-pad" role="none" style={{ height: rows.length * ROW_HEIGHT }}>
        <div
          className="ft-win"
          role="none"
          style={{ transform: `translateY(${virtual.first * ROW_HEIGHT}px)` }}
        >
          {rows.slice(virtual.first, virtual.last).map((row, offset) => {
            const index = virtual.first + offset
            return (
              <Row
                key={row.id}
                row={row}
                index={index}
                selected={index === selectedIndex}
                onPick={pick}
                onOpen={open}
                onMenu={menu}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
