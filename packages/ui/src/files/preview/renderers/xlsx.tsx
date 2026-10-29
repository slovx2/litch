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
  const firstRow = Math.max(1, Math.floor(view.top / HEIGHT) - 2),
    lastRow = Math.min(sheet.rows, Math.ceil((view.top + view.height) / HEIGHT) + 2)
  const firstCol = Math.max(1, Math.floor(view.left / WIDTH) - 1),
    lastCol = Math.min(sheet.columns, Math.ceil((view.left + view.width) / WIDTH) + 1)
  const cells = []
  for (let row = firstRow; row <= lastRow; row++) {
    cells.push(
      <div
        className="office-row-number"
        key={`r${row}`}
        style={{ top: row * HEIGHT, left: view.left }}
      >
        {row}
      </div>,
    )
    for (let col = firstCol; col <= lastCol; col++) {
      const merge = sheet.merges.find(
        (m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right,
      )
      if (
        merge &&
        (row !== Math.max(merge.top, firstRow) || col !== Math.max(merge.left, firstCol))
      )
        continue
      const actualRow = merge?.top ?? row,
        actualCol = merge?.left ?? col
      const text = sheet.cells[`${actualRow}:${actualCol}`] ?? ''
      cells.push(
        // biome-ignore lint/a11y/useSemanticElements: 虚拟单元格按绝对坐标定位，不使用浏览器表格布局。
        <div
          role="gridcell"
          tabIndex={-1}
          aria-rowindex={actualRow}
          aria-colindex={actualCol}
          title={text}
          key={`${actualRow}:${actualCol}`}
          className="office-cell"
          style={{
            top: actualRow * HEIGHT,
            left: GUTTER + (actualCol - 1) * WIDTH,
            width: (merge ? merge.right - merge.left + 1 : 1) * WIDTH,
            height: (merge ? merge.bottom - merge.top + 1 : 1) * HEIGHT,
          }}
        >
          {text}
        </div>,
      )
    }
  }
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
          {Array.from({ length: Math.max(0, lastCol - firstCol + 1) }, (_, i) => {
            const col = firstCol + i
            return (
              // biome-ignore lint/a11y/useSemanticElements: 虚拟列头与单元格使用同一套绝对坐标。
              <div
                key={col}
                role="columnheader"
                tabIndex={-1}
                className="office-column"
                style={{ top: view.top, left: GUTTER + (col - 1) * WIDTH }}
              >
                {columnName(col)}
              </div>
            )
          })}
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
      <p className="office-note">{t('preview.xlsx.note')}</p>
      {error ? (
        <div className="fv-hold" role="status">
          {t(`preview.xlsx.${error}`)}
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
