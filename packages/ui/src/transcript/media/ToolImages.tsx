import {
  type DeviceView,
  type FilePreview,
  type ItemView,
  keys,
  TOOL_IMAGE_PREFIX,
  type ToolImage,
} from '@litch/core'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useT } from '../../app/appearance.ts'
import { useKey, useServices } from '../../app/services.tsx'
import { PreviewResources } from '../../files/preview/resources.ts'
import { usePreviewImage } from '../../files/preview/use-image.ts'
import { TurnTouch } from '../state.ts'
import './tool-images.css'

const Gallery = createContext<ToolImage[]>([])
/** 没有图片的摘要保持原有 DOM，避免影响条目定位和滚动锚点。 */
export function ToolImageSummary({ active, children }: { active: boolean; children: ReactNode }) {
  return active ? <div className="tool-image-summary">{children}</div> : <>{children}</>
}
export function imagesIn(items: ItemView[]): ToolImage[] {
  return [
    ...new Map(
      items
        .flatMap((item) => (item.kind === 'toolCall' ? (item.images ?? []) : []))
        .map((image) => [image.id, image]),
    ).values(),
  ]
}
export function ToolImageGroup({ items, children }: { items: ItemView[]; children: ReactNode }) {
  const images = useMemo(() => imagesIn(items), [items])
  return <Gallery.Provider value={images}>{children}</Gallery.Provider>
}

/** 按 Claude 的工具组：折叠时聚合，展开时每个工具只露自己的最近几张，查看范围仍是整组。 */
export function ToolImageStrip({
  deviceId,
  images: own,
}: {
  deviceId: string
  images?: ToolImage[]
}) {
  const group = useContext(Gallery)
  const touch = useContext(TurnTouch)
  const device = useKey<DeviceView>(keys.device(deviceId))
  const [selected, select] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 隐私设置或连接身份改变必须关闭已有查看器。
  useEffect(() => {
    select(null)
  }, [device?.toolImagesEnabled, device?.connection])
  const t = useT()
  const entries = own ?? group
  const all = group.length ? group : entries
  if (device?.toolImagesEnabled === false || !entries.length) return null
  const visible = entries.slice(-3)
  const open = (id: string) => {
    touch()
    select(id)
  }
  return (
    <>
      <span className="tool-images" data-tool-images="">
        {entries.length > 3 ? (
          <button
            type="button"
            className="tool-images-more tool-images-wide"
            onClick={(event) => {
              event.currentTarget.focus()
              open(entries[0]!.id)
            }}
          >
            +{entries.length - 3}
          </button>
        ) : null}
        {entries.length > 1 ? (
          <button
            type="button"
            className="tool-images-more tool-images-narrow"
            onClick={(event) => {
              event.currentTarget.focus()
              open(entries[0]!.id)
            }}
          >
            +{entries.length - 1}
          </button>
        ) : null}
        {visible.map((image, index) => (
          <span
            key={image.id}
            className={`tool-image-chip ${index < visible.length - 1 ? 'tool-images-wide' : ''}`}
          >
            <button
              type="button"
              className="tool-image-open"
              aria-label={t('tool.image.view')}
              onClick={(event) => {
                event.currentTarget.focus()
                open(image.id)
              }}
            >
              {image.thumbnail ? (
                <img
                  src={`data:image/png;base64,${image.thumbnail.dataBase64}`}
                  alt={image.tool}
                  width={image.thumbnail.width}
                  height={image.thumbnail.height}
                />
              ) : (
                <span>▧</span>
              )}
            </button>
            <span className="tool-image-hover" role="tooltip">
              {image.thumbnail ? (
                <img src={`data:image/png;base64,${image.thumbnail.dataBase64}`} alt="" />
              ) : null}
              <span>
                {image.tool} · {all.findIndex((entry) => entry.id === image.id) + 1} / {all.length}
              </span>
            </span>
          </span>
        ))}
      </span>
      {selected ? (
        <ToolImageViewer
          key={selected}
          deviceId={deviceId}
          entries={all}
          selected={selected}
          close={() => select(null)}
        />
      ) : null}
    </>
  )
}

function ToolImageViewer({
  deviceId,
  entries,
  selected,
  close,
}: {
  deviceId: string
  entries: ToolImage[]
  selected: string
  close(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const dialog = useRef<HTMLDialogElement>(null)
  const [index, setIndex] = useState(
    Math.max(
      0,
      entries.findIndex((image) => image.id === selected),
    ),
  )
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; origin: typeof offset; moved: boolean } | null>(null)
  const [loaded, setLoaded] = useState<{ id: string; value: FilePreview } | null>(null)
  const [lease, setLease] = useState<{ id: string; resources: PreviewResources } | null>(null)
  const entry = entries[index]!
  const resources = lease?.id === entry.id ? lease.resources : null
  const content = loaded?.id === entry.id ? loaded.value : null
  // 工具组可以含很多截图；只为当前原图记预算，切图即取消并释放上一张，不累计到第17张就拒绝。
  useEffect(() => {
    const next = new PreviewResources((scope, _format, signal) =>
      channel.command('media.image', { deviceId: scope.deviceId, source: scope.path }, { signal }),
    )
    setLease({ id: entry.id, resources: next })
    return () => next.dispose()
  }, [channel, entry.id])
  const { image, failure } = usePreviewImage(content, resources, entry.id)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => {
      before?.focus()
    }
  }, [])
  useEffect(() => {
    if (!resources) return
    let live = true
    const path = TOOL_IMAGE_PREFIX + entry.id
    void resources.load({ deviceId, path, root: '' }, 'image', true).then(
      (value) => {
        if (live) setLoaded({ id: entry.id, value })
      },
      () => {
        if (live) setLoaded({ id: entry.id, value: { kind: 'invalid', path } })
      },
    )
    return () => {
      live = false
    }
  }, [resources, deviceId, entry.id])
  const reset = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }
  const move = (at: number) => {
    setIndex(Math.max(0, Math.min(entries.length - 1, at)))
    reset()
  }
  const backdrop = () => {
    if (zoom !== 1) reset()
    else close()
  }
  return (
    <dialog
      ref={dialog}
      className="tool-image-dialog"
      aria-label={t('tool.blob.image')}
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
      onKeyDown={(event) => {
        const at =
          event.key === 'ArrowLeft'
            ? index - 1
            : event.key === 'ArrowRight'
              ? index + 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? entries.length - 1
                  : null
        if (at !== null) {
          event.preventDefault()
          move(at)
        }
      }}
    >
      <button
        type="button"
        className="tool-image-backdrop"
        tabIndex={-1}
        aria-label={t('viewer.close')}
        onClick={backdrop}
      />
      <button
        type="button"
        className="ibtn tool-image-close"
        aria-label={t('viewer.close')}
        onClick={close}
      >
        ×
      </button>
      <div className="tool-image-slide">
        {image && !failure ? (
          <button
            type="button"
            className="tool-image-stage"
            aria-label={t('preview.zoomIn')}
            onWheel={(event) => {
              if (!event.ctrlKey) return
              event.preventDefault()
              const max = Math.max(
                2,
                image.width /
                  (event.currentTarget.querySelector('img')?.clientWidth ?? image.width),
              )
              const next = Math.min(max, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15))
              if (next <= 1.05) reset()
              else setZoom(Math.max(1.25, next))
            }}
            onClick={(event) => {
              if (!drag.current?.moved) {
                if (zoom === 1)
                  setZoom(
                    Math.max(
                      2,
                      image.width /
                        (event.currentTarget.querySelector('img')?.clientWidth ?? image.width),
                    ),
                  )
                else reset()
              }
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { x: event.clientX, y: event.clientY, origin: offset, moved: false }
            }}
            onPointerMove={(event) => {
              const start = drag.current
              if (start && event.buttons && zoom > 1) {
                start.moved =
                  Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3
                setOffset({
                  x: start.origin.x + event.clientX - start.x,
                  y: start.origin.y + event.clientY - start.y,
                })
              }
            }}
          >
            <img
              src={image.url}
              alt={entry.tool}
              draggable={false}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
            />
          </button>
        ) : (
          <p role="status">
            {t(
              failure ??
                (content && content.kind !== 'ready' ? 'files.view.failed' : 'files.view.loading'),
            )}
          </p>
        )}
      </div>
      <nav className="tool-image-nav" aria-label={t('tool.image.view')}>
        <button
          type="button"
          className="ibtn"
          disabled={index === 0}
          aria-label={t('media.previous')}
          onClick={() => move(index - 1)}
        >
          ←
        </button>
        <span>
          {index + 1} / {entries.length}
        </span>
        <button
          type="button"
          className="ibtn"
          disabled={index === entries.length - 1}
          aria-label={t('media.next')}
          onClick={() => move(index + 1)}
        >
          →
        </button>
      </nav>
    </dialog>
  )
}
