import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { Close } from '../app/icons.tsx'
import { drawMermaid, firstLine, useLook } from './mermaid.ts'

interface MermaidBlockProps {
  text: string
  /** 代码块还没写完（流式输出中、围栏还没闭合）：先显示源码，写完再画 */
  open: boolean
  anchor?: string | undefined
}

type Drawn =
  | { look: string; text: string; svg: string }
  | { look: string; text: string; error: string }

/**
 * mermaid 代码块：画成图。块头上可以在“图 / 源码”之间切换、复制源码、放大查看。
 * 还没写完、画图库还在装载、画不出来（语法错）的时候显示源码；画不出来时块头写出错误的第一行。
 */
export const MermaidBlock = memo(function MermaidBlock({ text, open, anchor }: MermaidBlockProps) {
  const t = useT()
  const look = useLook()
  const [source, setSource] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  useEffect(() => {
    if (open) return
    let alive = true
    drawMermaid(text, look).then(
      (svg) => alive && setDrawn({ look, text, svg }),
      (error: unknown) => alive && setDrawn({ look, text, error: firstLine(error) }),
    )
    return () => {
      alive = false
    }
  }, [text, look, open])

  // 换了外观、正在重画时先留着上一张，免得块的高度来回跳
  const current = !open && drawn?.text === text ? drawn : null
  const svg = current && 'svg' in current ? current.svg : null
  const error = current && 'error' in current ? current.error : null
  const figure = svg !== null && !source

  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1500)
      },
      () => {},
    )
  }

  return (
    <div className="code mmd" data-anchor={anchor}>
      <div className="code-head">
        <span className="mmd-lang">mermaid</span>
        {error ? (
          <span className="mmd-err" title={error}>
            {t('mermaid.failed', { reason: error })}
          </span>
        ) : null}
        <span className="mmd-tools">
          {svg !== null ? (
            // biome-ignore lint/a11y/useSemanticElements: 沿用别处那排按钮的写法（.seg），用 fieldset 会带出浏览器自己的边框和排版
            <span className="seg mmd-seg" role="group" aria-label={t('mermaid.view')}>
              <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
                {t('mermaid.figure')}
              </button>
              <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
                {t('mermaid.source')}
              </button>
            </span>
          ) : null}
          <button type="button" className="mini" onClick={copy}>
            {t(copied ? 'code.copied' : 'code.copy')}
          </button>
          {svg !== null ? (
            <button type="button" className="mini" onClick={() => setZoomed(true)}>
              {t('mermaid.zoom')}
            </button>
          ) : null}
        </span>
      </div>
      {figure ? (
        <Figure svg={svg} scale={Number(current?.look.split(':')[1])} />
      ) : (
        <pre>
          <code>{text}</code>
        </pre>
      )}
      {zoomed && svg !== null ? <MermaidViewer svg={svg} onClose={() => setZoomed(false)} /> : null}
    </div>
  )
})

/**
 * 画好的 SVG 放进页面。它是画图库在严格模式下输出、自己净化过的；
 * 页面的内容安全策略也不许内联脚本，图里就算带了也不会执行。
 */
function Figure({ svg, scale }: { svg: string; scale: number }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (host.current) {
      host.current.innerHTML = svg
      const figure = host.current.querySelector('svg')
      // 默认档沿用宽图适配容器；只有放大字号时保留重画后的尺寸，避免适配宽度抵消放大。
      if (scale > 1 && figure?.viewBox.baseVal.width) {
        figure.style.width = `${figure.viewBox.baseVal.width}px`
        figure.style.maxWidth = 'none'
        figure.style.flex = 'none'
      }
    }
  }, [svg, scale])
  return <div ref={host} className="mmd-fig" />
}

/** 把平移缩放写到图上 */
function place(
  stage: HTMLDivElement | null,
  { x, y, scale }: { x: number; y: number; scale: number },
) {
  if (stage) stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
}

const MIN_SCALE = 0.2
const MAX_SCALE = 8

/** 放大查看：盖在整个窗口上，滚轮缩放（以鼠标处为中心）、拖动平移、双击复原。Esc、点关闭按钮关上 */
function MermaidViewer({ svg, onClose }: { svg: string; onClose(): void }) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const view = useRef({ x: 0, y: 0, scale: 1 })
  /** 刚打开时那一档：整张图放得下，最多放大到两倍 */
  const fit = useRef({ x: 0, y: 0, scale: 1 })
  const drag = useRef<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    const element = dialog.current
    const holder = stage.current
    if (!element || !holder) return
    if (!element.open) element.showModal()
    holder.innerHTML = svg
    const figure = holder.querySelector('svg')
    if (!figure) return
    // 按图本来的大小画，再整体缩放；不然它会照块里的宽度缩成一条
    const box = figure.viewBox.baseVal
    const width = box?.width || figure.getBoundingClientRect().width || 1
    const height = box?.height || figure.getBoundingClientRect().height || 1
    figure.style.maxWidth = 'none'
    figure.style.width = `${width}px`
    figure.style.height = `${height}px`
    const room = element.getBoundingClientRect()
    const scale = Math.min(2, (room.width - 64) / width, (room.height - 96) / height)
    fit.current = {
      scale,
      x: (room.width - width * scale) / 2,
      y: (room.height - height * scale) / 2,
    }
    view.current = { ...fit.current }
    place(stage.current, view.current)
  }, [svg])

  const onWheel = (event: React.WheelEvent) => {
    const before = view.current
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, before.scale * Math.exp(-event.deltaY * 0.002)),
    )
    // 鼠标底下那一点缩放前后不动
    const ratio = scale / before.scale
    view.current = {
      scale,
      x: event.clientX - (event.clientX - before.x) * ratio,
      y: event.clientY - (event.clientY - before.y) * ratio,
    }
    place(stage.current, view.current)
  }

  return (
    <dialog
      ref={dialog}
      className="viewer mmd-viewer"
      aria-label={t('mermaid.label')}
      onClose={onClose}
      onWheel={onWheel}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target as Element).closest('button')) return
        drag.current = { x: event.clientX - view.current.x, y: event.clientY - view.current.y }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        view.current = {
          ...view.current,
          x: event.clientX - drag.current.x,
          y: event.clientY - drag.current.y,
        }
        place(stage.current, view.current)
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onDoubleClick={() => {
        view.current = { ...fit.current }
        place(stage.current, view.current)
      }}
    >
      <div ref={stage} className="mmd-stage" />
      <div className="mmd-hint">{t('mermaid.hint')}</div>
      <button
        type="button"
        className="ibtn viewer-x"
        title={t('viewer.close')}
        aria-label={t('viewer.close')}
        onClick={onClose}
      >
        <Close />
      </button>
    </dialog>
  )
}
