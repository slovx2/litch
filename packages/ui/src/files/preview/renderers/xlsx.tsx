import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { errorKind, type OfficeError } from '../office/archive.ts'
import { officeJob } from '../office/job.ts'
import type { SheetData, WorkbookData } from '../office/model.ts'
import '../office/office.css'

const HEIGHT = 28,
  WIDTH = 136,
  GUTTER = 48
function columnName(value: number): string {
  let label = ''
  for (let n = value; n > 0; n = Math.floor((n - 1) / 26))
    label = String.fromCharCode(65 + ((n - 1) % 26)) + label
  return label
}
/** 一块区域里看得见的单元格。合并区只在左上角画一次；位置由区域决定（冻结的部分跟着视口走） */
function regionCells(
  sheet: SheetData,
  rows: [number, number],
  cols: [number, number],
  top: (row: number) => number,
  left: (col: number) => number,
  region: string,
) {
  const { rows: frozenRows, columns: frozenCols } = sheet.frozen
  const cells = []
  for (let row = rows[0]; row <= rows[1]; row++) {
    for (let col = cols[0]; col <= cols[1]; col++) {
      const merge = sheet.merges.find(
        (m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right,
      )
      if (merge && (row !== Math.max(merge.top, rows[0]) || col !== Math.max(merge.left, cols[0])))
        continue
      const actualRow = merge?.top ?? row,
        actualCol = merge?.left ?? col
      const key = `${actualRow}:${actualCol}`
      const text = sheet.cells[key] ?? ''
      const lastRow = merge?.bottom ?? row,
        lastCol = merge?.right ?? col
      const edge = [
        lastRow === frozenRows ? 'row' : '',
        lastCol === frozenCols ? 'col' : '',
      ].join(' ')
      cells.push(
        // biome-ignore lint/a11y/useSemanticElements: 虚拟单元格按绝对坐标定位，不使用浏览器表格布局。
        <div
          role="gridcell"
          tabIndex={-1}
          aria-rowindex={actualRow}
          aria-colindex={actualCol}
          title={text}
          key={`${region}${key}`}
          className="office-cell"
          data-region={region || undefined}
          data-edge={edge.trim() || undefined}
          data-num={sheet.numeric[key] || undefined}
          style={{
            top: top(actualRow),
            left: left(actualCol),
            width: (merge ? merge.right - merge.left + 1 : 1) * WIDTH,
            height: (merge ? merge.bottom - merge.top + 1 : 1) * HEIGHT,
          }}
        >
          {text}
        </div>,
      )
    }
  }
  return cells
}
function Grid({ sheet }: { sheet: SheetData }) {
  const t = useT(),
    host = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, left: 0, width: 600, height: 400 })
  useEffect(() => {
    const el = host.current
    if (!el) return
    el.scrollTo(0, 0)
    const update = () =>
      setView({
        top: el.scrollTop,
        left: el.scrollLeft,
        width: el.clientWidth,
        height: el.clientHeight,
      })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [])
  const frozenRows = Math.min(sheet.frozen.rows, sheet.rows),
    frozenCols = Math.min(sheet.frozen.columns, sheet.columns)
  const firstRow = Math.max(1, Math.floor(view.top / HEIGHT) - 2),
    lastRow = Math.min(sheet.rows, Math.ceil((view.top + view.height) / HEIGHT) + 2)
  const firstCol = Math.max(1, Math.floor(view.left / WIDTH) - 1),
    lastCol = Math.min(sheet.columns, Math.ceil((view.left + view.width) / WIDTH) + 1)
  const rowTop = (row: number) => row * HEIGHT,
    colLeft = (col: number) => GUTTER + (col - 1) * WIDTH
  // 冻结的行列钉在视口上：位置加上滚动量，画在可滚动的部分之上
  const pinnedTop = (row: number) => view.top + row * HEIGHT,
    pinnedLeft = (col: number) => view.left + GUTTER + (col - 1) * WIDTH
  const cells = regionCells(sheet, [firstRow, lastRow], [firstCol, lastCol], rowTop, colLeft, '')
  if (frozenCols)
    cells.push(
      ...regionCells(sheet, [firstRow, lastRow], [1, frozenCols], rowTop, pinnedLeft, 'c'),
    )
  if (frozenRows)
    cells.push(
      ...regionCells(sheet, [1, frozenRows], [firstCol, lastCol], pinnedTop, colLeft, 'r'),
    )
  if (frozenRows && frozenCols)
    cells.push(
      ...regionCells(sheet, [1, frozenRows], [1, frozenCols], pinnedTop, pinnedLeft, 'rc'),
    )
  const numbers = []
  for (let row = firstRow; row <= lastRow; row++)
    numbers.push(
      <div className="office-row-number" key={`n${row}`} style={{ top: row * HEIGHT, left: view.left }}>
        {row}
      </div>,
    )
  for (let row = 1; row <= frozenRows; row++)
    numbers.push(
      <div
        className="office-row-number"
        data-edge={row === frozenRows ? 'row' : undefined}
        key={`f${row}`}
        style={{ top: view.top + row * HEIGHT, left: view.left }}
      >
        {row}
      </div>,
    )
  const header = (col: number, pinned: boolean) => (
    // biome-ignore lint/a11y/useSemanticElements: 虚拟列头与单元格使用同一套绝对坐标。
    <div
      key={`${pinned ? 'f' : 'h'}${col}`}
      role="columnheader"
      tabIndex={-1}
      className="office-column"
      data-edge={col === frozenCols ? 'col' : undefined}
      style={{ top: view.top, left: pinned ? pinnedLeft(col) : colLeft(col) }}
    >
      {columnName(col)}
    </div>
  )
  const headers = []
  for (let col = firstCol; col <= lastCol; col++) headers.push(header(col, false))
  for (let col = 1; col <= frozenCols; col++) headers.push(header(col, true))
  return (
    // biome-ignore lint/a11y/useSemanticElements: 只挂载可见单元格的虚拟网格，容器可用键盘滚动。
    <div
      className="office-grid"
      ref={host}
      role="grid"
      aria-label={sheet.name}
      aria-rowcount={sheet.rows}
      aria-colcount={sheet.columns}
      tabIndex={0}
    >
      {sheet.rows === 0 ? (
        <div className="fv-hold">{t('preview.xlsx.empty')}</div>
      ) : (
        <div
          className="office-grid-space"
          style={{ width: GUTTER + sheet.columns * WIDTH, height: (sheet.rows + 1) * HEIGHT }}
        >
          {cells}
          {numbers}
          {headers}
          <div className="office-corner" style={{ top: view.top, left: view.left }} />
        </div>
      )}
    </div>
  )
}
export default function XlsxPreview({ data }: PreviewRendererProps) {
  const t = useT()
  const [book, setBook] = useState<WorkbookData | null>(null),
    [error, setError] = useState<OfficeError | null>(null),
    [sheet, setSheet] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setBook(null)
    setError(null)
    setSheet(0)
    officeJob<WorkbookData>(data, 'xlsx', abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setBook(value)
      },
      (reason) => {
        if (!abort.signal.aborted) setError(errorKind(reason))
      },
    )
    return () => abort.abort()
  }, [data])
  return (
    <div
      className="office-preview"
      data-office="xlsx"
      data-state={error ?? (book ? 'ready' : 'loading')}
    >
      {error ? null : <p className="office-note">{t('preview.xlsx.note')}</p>}
      {error ? (
        <div className="fv-hold" data-hold={error} role="status">
          <b>{t(error === 'budget' ? 'files.view.tooLarge' : 'files.view.failed')}</b>
          <span>{t(`preview.xlsx.${error}`)}</span>
        </div>
      ) : !book ? (
        <div className="fv-hold" role="status">
          {t('files.view.loading')}
        </div>
      ) : (
        <>
          {book.sheets[sheet] ? (
            <Grid key={sheet} sheet={book.sheets[sheet]} />
          ) : (
            <div className="fv-hold">{t('preview.xlsx.empty')}</div>
          )}
          <div className="office-sheets" role="tablist" aria-label={t('preview.xlsx.sheets')}>
            {book.sheets.map((item, i) => (
              <button
                key={item.name}
                type="button"
                role="tab"
                aria-selected={sheet === i}
                onClick={() => setSheet(i)}
              >
                {item.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
