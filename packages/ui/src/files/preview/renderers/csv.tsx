import { decodeBase64 } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import type { CsvTable } from '../web/csv.ts'
import '../web.css'

const ROW = 28
const COLUMN = 180
const GUTTER = 56
// 单个字段也可能占满 2 MiB；保留原值，只限制交给浏览器排版的文字长度。
const cellText = (value = '') => (value.length > 4096 ? `${value.slice(0, 4096)}…` : value)

export default function CsvPreview({ data, scope, resources }: PreviewRendererProps) {
  const t = useT()
  const [table, setTable] = useState<CsvTable | null>(null)
  const [failed, setFailed] = useState(false)
  const [view, setView] = useState({ top: 0, left: 0, height: 600, width: 800 })
  const viewport = useRef<HTMLElement>(null)
  useEffect(() => {
    setTable(null)
    setFailed(false)
    const worker = new Worker(new URL('../web/csv.worker.ts', import.meta.url), { type: 'module' })
    let alive = true
    const stop = () => {
      worker.terminate()
      clearTimeout(timer)
    }
    const fail = () => {
      if (alive) setFailed(true)
      stop()
    }
    const timer = setTimeout(fail, 5000)
    worker.onerror = fail
    worker.onmessage = (event: MessageEvent<{ table?: CsvTable; error?: boolean }>) => {
      if (alive) {
        if (event.data.table) setTable(event.data.table)
        else setFailed(true)
      }
      stop()
    }
    resources.abort.signal.addEventListener('abort', stop, { once: true })
    const bytes = new Uint8Array(decodeBase64(data.dataBase64))
    worker.postMessage({ buffer: bytes.buffer, tsv: /\.tsv$/i.test(scope.path) }, [bytes.buffer])
    return () => {
      alive = false
      stop()
      resources.abort.signal.removeEventListener('abort', stop)
    }
  }, [data, scope.path, resources])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 表格就绪后滚动容器才挂载。
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () =>
      setView((old) => ({ ...old, width: element.clientWidth, height: element.clientHeight }))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [table])
  if (!table || failed)
    return (
      <div className="fv-hold" role="status">
        <span>{t(failed ? 'preview.csv.invalid' : 'files.view.loading')}</span>
      </div>
    )
  const first = Math.max(0, Math.floor(view.top / ROW) - 2)
  const end = Math.min(table.rows.length, first + Math.ceil(view.height / ROW) + 5)
  const col = Math.max(0, Math.floor(view.left / COLUMN) - 1)
  const lastCol = Math.min(table.columns, col + Math.ceil(view.width / COLUMN) + 3)
  const columns = Array.from({ length: lastCol - col }, (_, index) => index + col)
  return (
    <div className="fp-web fp-csv">
      <div className="fp-web-note" role="status">
        {t('preview.csv.size', { rows: table.rows.length, columns: table.columns })}
        {table.rowLimit || table.columnLimit ? <span>{t('preview.csv.limit')}</span> : null}
        {table.errors ? <span>{t('preview.csv.errors')}</span> : null}
      </div>
      <section
        className="fp-csv-viewport"
        ref={viewport}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 键盘用户需聚焦滚动区域。
        tabIndex={0}
        aria-label={t('preview.csv.table')}
        onScroll={(event) => {
          const el = event.currentTarget
          setView((old) => ({ ...old, top: el.scrollTop, left: el.scrollLeft }))
        }}
      >
        <table
          className="fp-csv-grid"
          aria-rowcount={table.rows.length + 1}
          aria-colcount={table.columns + 1}
          style={{ width: GUTTER + table.columns * COLUMN, height: (table.rows.length + 1) * ROW }}
        >
          <thead>
            <tr className="fp-csv-head" style={{ height: ROW }}>
              <th className="fp-csv-number" scope="col" style={{ width: GUTTER }}>
                #
              </th>
              {columns.map((c) => (
                <th
                  className="fp-csv-cell"
                  scope="col"
                  key={c}
                  style={{ left: GUTTER + c * COLUMN, width: COLUMN }}
                >
                  {c + 1}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(first, end).map((row, offset) => {
              const index = first + offset
              return (
                <tr
                  className="fp-csv-row"
                  aria-rowindex={index + 2}
                  key={index}
                  style={{ top: (index + 1) * ROW, height: ROW }}
                >
                  <th className="fp-csv-number" scope="row" style={{ width: GUTTER }}>
                    {index + 1}
                  </th>
                  {columns.map((c) => (
                    <td
                      className="fp-csv-cell"
                      aria-colindex={c + 2}
                      key={c}
                      style={{ left: GUTTER + c * COLUMN, width: COLUMN }}
                      title={cellText(row[c])}
                    >
                      {cellText(row[c])}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}
