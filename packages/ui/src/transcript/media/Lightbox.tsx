import { useEffect, useRef, useState } from 'react'
import { useT } from '../../app/appearance.ts'
import { Icon } from '../../app/icons.tsx'

export interface GalleryImage {
  id: string
  url: string
  width: number
  height: number
  label: string
  href: string
  reveal?: () => void
  save?: (() => void) | undefined
}

export function Lightbox({
  entries,
  selected,
  close,
}: {
  entries: GalleryImage[]
  selected: string
  close(): void
}) {
  const t = useT()
  const dialog = useRef<HTMLDialogElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [index, setIndex] = useState(
    Math.max(
      0,
      entries.findIndex((entry) => entry.id === selected),
    ),
  )
  const [scale, setScale] = useState<number | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [error, setError] = useState(false)
  const drag = useRef<{
    x: number
    y: number
    origin: typeof offset
    pointerId: number
    moved: boolean
    blank: boolean
  } | null>(null)
  const entry = entries[index]
  useEffect(() => {
    const element = dialog.current
    const before = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => {
      element?.close()
      before?.focus()
    }
  }, [])
  if (!entry) return null
  const reset = () => {
    setScale(null)
    setOffset({ x: 0, y: 0 })
  }
  const next = (step: number) => {
    setIndex((at) => Math.max(0, Math.min(entries.length - 1, at + step)))
    reset()
    setError(false)
  }
  const zoom = (factor: number) => {
    const fitted = (img.current?.clientWidth ?? entry.width) / entry.width
    setScale(Math.min(8, Math.max(0.05, (scale ?? fitted) * factor)))
  }
  const copy = async () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = entry.width
      canvas.height = entry.height
      const context = canvas.getContext('2d')
      if (!context || !img.current) throw new Error('图片尚未加载')
      context.drawImage(img.current, 0, 0, entry.width, entry.height)
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('图片无法复制'))),
          'image/png',
        ),
      )
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setError(false)
    } catch {
      setError(true)
    }
  }
  const save = () => {
    if (entry.save) return entry.save()
    const link = document.createElement('a')
    link.href = entry.url
    link.download = entry.href.split('/').pop()?.split(/[?#]/)[0] || 'image'
    link.click()
  }
  return (
    <dialog
      ref={dialog}
      className="media-lightbox"
      aria-label={entry.label}
      onPointerDown={(event) => {
        if (
          event.button !== 0 ||
          (event.target instanceof Element && event.target.closest('.media-lightbox-tools'))
        )
          return
        if (drag.current) {
          drag.current.moved = true
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          origin: offset,
          pointerId: event.pointerId,
          moved: false,
          blank: event.target !== img.current,
        }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start || start.pointerId !== event.pointerId) return
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y
        start.moved ||= Math.hypot(dx, dy) > 4
        if (start.moved) setOffset({ x: start.origin.x + dx, y: start.origin.y + dy })
      }}
      onPointerUp={(event) => {
        const start = drag.current
        if (!start || start.pointerId !== event.pointerId) return
        drag.current = null
        if (
          start.blank &&
          !start.moved &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 4
        )
          close()
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onDoubleClick={(event) => {
        if (!(event.target instanceof Element && event.target.closest('.media-lightbox-tools')))
          reset()
      }}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          next(event.key === 'ArrowLeft' ? -1 : 1)
        }
      }}
    >
      <div className="media-lightbox-tools">
        <button
          type="button"
          className="ibtn"
          aria-label={t('media.previous')}
          disabled={index === 0}
          onClick={() => next(-1)}
        >
          ←
        </button>
        <span>
          {index + 1} / {entries.length}
        </span>
        <button
          type="button"
          className="ibtn"
          aria-label={t('media.next')}
          disabled={index === entries.length - 1}
          onClick={() => next(1)}
        >
          →
        </button>
        <button
          type="button"
          className="ibtn"
          aria-label={t('preview.zoomOut')}
          onClick={() => zoom(0.8)}
        >
          <Icon name="minus" />
        </button>
        <button type="button" className="mini" onClick={reset}>
          {t('media.fit')}
        </button>
        <button
          type="button"
          className="mini"
          aria-label={t('preview.actual')}
          onClick={() => {
            setScale(1)
            setOffset({ x: 0, y: 0 })
          }}
        >
          100%
        </button>
        <button
          type="button"
          className="ibtn"
          aria-label={t('preview.zoomIn')}
          onClick={() => zoom(1.25)}
        >
          <Icon name="plus" />
        </button>
        <span className="grow" />
        <button
          type="button"
          className="ibtn"
          aria-label={t('media.copy')}
          onClick={() => void copy()}
        >
          <Icon name="copy" />
        </button>
        <button type="button" className="ibtn" aria-label={t('media.save')} onClick={save}>
          <Icon name="download" />
        </button>
        {entry.reveal ? (
          <button
            type="button"
            className="ibtn"
            aria-label={t('media.reveal')}
            onClick={() => {
              entry.reveal?.()
              close()
            }}
          >
            <Icon name="folder" />
          </button>
        ) : null}
        <button type="button" className="ibtn" aria-label={t('viewer.close')} onClick={close}>
          ×
        </button>
      </div>
      {error ? <small role="alert">{t('message.copy.failed')}</small> : null}
      <div
        ref={stage}
        className="media-lightbox-stage"
        onWheel={(event) => {
          event.preventDefault()
          if (drag.current) drag.current.moved = true
          zoom(event.deltaY < 0 ? 1.15 : 1 / 1.15)
        }}
      >
        <img
          ref={img}
          src={entry.url}
          alt={entry.label}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            ...(scale === null
              ? {}
              : {
                  width: entry.width * scale,
                  height: entry.height * scale,
                  maxWidth: 'none',
                  maxHeight: 'none',
                }),
          }}
        />
      </div>
    </dialog>
  )
}
