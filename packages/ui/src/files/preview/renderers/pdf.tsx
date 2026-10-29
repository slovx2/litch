import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { loadPdf, type PdfDocument, type PdfFailure } from '../pdf/load.ts'
import { PdfPage } from '../pdf/Page.tsx'
import { GAP, pageLayout, visiblePages } from '../pdf/policy.ts'
import '../pdf/pdf.css'

export default function PdfPreview({ data, resources }: PreviewRendererProps) {
  const t = useT()
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [failure, setFailure] = useState<PdfFailure | null>(null)
  const release = useRef<(() => void) | null>(null)
  const stop = useCallback(() => {
    setFailure('timeout')
    setPdf(null)
    release.current?.()
  }, [])
  useEffect(() => {
    setPdf(null)
    setFailure(null)
    if (resources.abort.signal.aborted) return
    const dispose = loadPdf(data, setPdf, setFailure)
    release.current = dispose
    resources.abort.signal.addEventListener('abort', dispose)
    return () => {
      dispose()
      resources.abort.signal.removeEventListener('abort', dispose)
    }
  }, [data, resources])
  if (!failure && !pdf)
    return (
      <div className="fv-hold fp-pdf-hold" role="status" data-pdf-error="">
        {t('preview.pdf.loading')}
      </div>
    )
  // 和其他文件占位一样：标题说结果（读不了、太大），下面一行说原因
  if (failure || !pdf)
    return (
      <div className="fv-hold fp-pdf-hold" role="status" data-pdf-error={failure ?? ''}>
        <b>
          {t(
            failure === 'pages' || failure === 'size' ? 'files.view.tooLarge' : 'files.view.failed',
          )}
        </b>
        <span>{t(`preview.pdf.${failure ?? 'invalid'}`)}</span>
      </div>
    )
  return <PdfPages pdf={pdf} stop={stop} />
}

function PdfPages({ pdf, stop }: { pdf: PdfDocument; stop(): void }) {
  const t = useT()
  const scroll = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ width: 640, height: 800, top: 0 })
  const [zoom, setZoom] = useState(1)
  const [input, setInput] = useState('1')
  const boxes = useMemo(
    () => pageLayout(pdf.sizes, room.width, zoom),
    [pdf.sizes, room.width, zoom],
  )
  const visible = visiblePages(boxes, room.top, room.height)
  const current = Math.max(
    1,
    boxes.findIndex((box) => box.top + Math.max(128, box.height) > room.top + GAP) + 1,
  )
  const last = boxes.at(-1)
  useEffect(() => {
    setInput(String(current))
  }, [current])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const resize = new ResizeObserver(() =>
      setRoom({ width: element.clientWidth, height: element.clientHeight, top: element.scrollTop }),
    )
    resize.observe(element)
    return () => resize.disconnect()
  }, [])
  const go = (page: number) => {
    const selected = Math.min(boxes.length, Math.max(1, Math.round(page)))
    if (Number.isFinite(selected) && selected !== current)
      scroll.current?.scrollTo({ top: Math.max(0, (boxes[selected - 1]?.top ?? GAP) - GAP) })
    setInput(String(Number.isFinite(selected) ? selected : current))
  }
  const changeZoom = (next: number) => {
    setZoom(next)
    const layout = pageLayout(pdf.sizes, room.width, next)
    // 缩放后保留当前页，下一帧再按新布局定位。
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({ top: (layout[current - 1]?.top ?? GAP) - GAP }),
    )
  }
  return (
    <div className="fp-pdf">
      <fieldset className="fp-tools fp-pdf-tools" aria-label={t('preview.pdf.controls')}>
        <div className="fp-pdf-pagination">
          <button
            type="button"
            className="mini"
            data-pdf="previous"
            disabled={current <= 1}
            onClick={() => go(current - 1)}
          >
            {t('preview.pdf.previous')}
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              go(Number(input))
            }}
          >
            <input
              aria-label={t('preview.pdf.page')}
              value={input}
              inputMode="numeric"
              onChange={(event) => setInput(event.target.value)}
              onBlur={() => go(Number(input))}
            />
            <span>{t('preview.pdf.total', { count: boxes.length })}</span>
          </form>
          <button
            type="button"
            className="mini"
            data-pdf="next"
            disabled={current >= boxes.length}
            onClick={() => go(current + 1)}
          >
            {t('preview.pdf.next')}
          </button>
        </div>
        <div className="fp-pdf-zoom">
          <button
            type="button"
            className="mini"
            data-pdf="out"
            disabled={zoom <= 0.5}
            aria-label={t('preview.zoomOut')}
            onClick={() => changeZoom(Math.max(0.5, zoom / 1.25))}
          >
            −
          </button>
          <span className="fp-scale" data-pdf="scale">
            {Math.round(((boxes[current - 1]?.scale ?? 1) * 72 * 100) / 96)}%
          </span>
          <button
            type="button"
            className="mini"
            data-pdf="in"
            disabled={zoom >= 3}
            aria-label={t('preview.zoomIn')}
            onClick={() => changeZoom(Math.min(3, zoom * 1.25))}
          >
            +
          </button>
          <span className="seg">
            <button
              type="button"
              data-pdf="fit"
              aria-pressed={zoom === 1}
              onClick={() => changeZoom(1)}
            >
              {t('preview.fit')}
            </button>
          </span>
        </div>
      </fieldset>
      <div
        ref={scroll}
        className="fp-pdf-scroll"
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop
          setRoom((before) => ({ ...before, top }))
        }}
      >
        <div
          className="fp-pdf-pages"
          style={{
            height: (last?.top ?? 0) + Math.max(128, last?.height ?? 0) + GAP,
            width: Math.max(room.width, ...boxes.map((box) => box.width + GAP * 2)),
          }}
        >
          {visible.map((index) =>
            boxes[index] ? (
              <PdfPage
                key={index}
                document={pdf.document}
                number={index + 1}
                box={boxes[index]}
                count={visible.length}
                stop={stop}
              />
            ) : null,
          )}
        </div>
      </div>
    </div>
  )
}
