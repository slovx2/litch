import {
  AnnotationMode,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
  TextLayer,
} from 'pdfjs-dist'
import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import { type PageBox, PDF_TEXT_CHARS, PDF_TEXT_ITEMS, PDF_TIMEOUT, rasterScale } from './policy.ts'

/** 独立页组件卸载即取消画布/文字流，清除像素和 PDF.js 页缓存。 */
export function PdfPage({
  document,
  number,
  box,
  count,
  stop,
}: {
  document: PDFDocumentProxy
  number: number
  box: PageBox
  count: number
  stop(): void
}) {
  const t = useT()
  const canvas = useRef<HTMLCanvasElement>(null)
  const text = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'textLimit'>('loading')
  const density = rasterScale(box, count, window.devicePixelRatio || 1)
  useEffect(() => {
    const surface = canvas.current,
      layer = text.current
    if (!surface || !layer) return
    let cancelled = false
    let page: PDFPageProxy | undefined,
      render: RenderTask | undefined,
      textLayer: TextLayer | undefined
    let reader: ReadableStreamDefaultReader | undefined
    const timer = window.setTimeout(stop, PDF_TIMEOUT)
    setState('loading')
    const run = async () => {
      page = await document.getPage(number)
      if (cancelled) return
      const viewport = page.getViewport({ scale: box.scale })
      layer.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
      surface.width = Math.max(1, Math.floor(viewport.width * density))
      surface.height = Math.max(1, Math.floor(viewport.height * density))
      render = page.render({
        canvas: surface,
        viewport,
        transform: [density, 0, 0, density, 0, 0],
        annotationMode: AnnotationMode.DISABLE,
      })
      await render.promise
      if (cancelled) return
      // 逐块读文字流；在创建大量 DOM 前截断，并仍保留已经画好的页面。
      const content = {
        items: [] as Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'],
        styles: {},
        lang: null,
      }
      let chars = 0
      reader = page.streamTextContent().getReader()
      while (!cancelled) {
        const chunk = await reader.read()
        if (chunk.done) break
        const value = chunk.value as Awaited<ReturnType<PDFPageProxy['getTextContent']>>
        chars += value.items.reduce((sum, item) => sum + ('str' in item ? item.str.length : 0), 0)
        if (chars > PDF_TEXT_CHARS || content.items.length + value.items.length > PDF_TEXT_ITEMS) {
          // 末块可能已在 Worker 关闭流，不等待取消回执才能及时结束本页。
          void reader.cancel(new Error('PDF text budget exceeded')).catch(() => {})
          setState('textLimit')
          return
        }
        content.items.push(...value.items)
        Object.assign(content.styles, value.styles)
      }
      if (cancelled) return
      textLayer = new TextLayer({ container: layer, viewport, textContentSource: content })
      await textLayer.render()
      if (!cancelled) setState('ready')
    }
    void run()
      .catch(() => {
        if (!cancelled) setState('invalid')
      })
      .finally(() => window.clearTimeout(timer))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      render?.cancel()
      textLayer?.cancel()
      void reader?.cancel(new Error('PDF page released')).catch(() => {})
      surface.width = surface.height = 0
      layer.replaceChildren()
      page?.cleanup()
    }
  }, [document, number, box.scale, density, stop])
  return (
    <section
      className="fp-pdf-page"
      data-page={number}
      data-state={state}
      aria-label={t('preview.pdf.pageLabel', { page: number })}
      style={{ width: box.width, height: box.height, top: box.top }}
    >
      <canvas ref={canvas} style={{ width: box.width, height: box.height }} />
      <div
        ref={text}
        className="fp-pdf-text"
        style={{ '--total-scale-factor': box.scale } as React.CSSProperties}
      />
      {state !== 'ready' ? (
        <span className="fp-pdf-page-status" role="status">
          {t(`preview.pdf.${state}`)}
        </span>
      ) : null}
    </section>
  )
}
