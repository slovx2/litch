import { useEffect, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { usePreviewImage } from '../use-image.ts'

export default function ImagePreview({ data, scope, resources }: PreviewRendererProps) {
  const t = useT()
  const [actual, setActual] = useState(false)
  const [scale, setScale] = useState(1)
  /** 适应宽度时图实际画出来的比例，工具条上写的是它，放大缩小也从它起步 */
  const [fitScale, setFitScale] = useState(1)
  const image = useRef<HTMLImageElement>(null)
  const { image: resource, failure: failed, fail } = usePreviewImage(data, resources, scope.path)
  const url = resource?.url ?? ''
  const width = resource?.width ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: 图在有了 url 之后才挂上，那时才量得到
  useEffect(() => {
    const element = image.current
    if (actual || !element || !width) return
    const measure = () => setFitScale(element.clientWidth / width || 1)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [actual, url, width])
  if (!resource || failed)
    return (
      <div className="fv-hold" data-hold="invalidImage" role="status">
        <b>{t('files.view.group.image')}</b>
        <span>{t(failed ?? 'preview.imageInvalid')}</span>
      </div>
    )
  const shown = actual ? scale : fitScale
  const zoom = (factor: number) => {
    setActual(true)
    setScale(Math.min(4, Math.max(0.25, shown * factor)))
  }
  return (
    <div className="fp-image">
      <div className="fp-tools">
        <span className="seg">
          <button type="button" aria-pressed={!actual} onClick={() => setActual(false)}>
            {t('preview.fit')}
          </button>
          <button
            type="button"
            aria-pressed={actual && scale === 1}
            onClick={() => {
              setActual(true)
              setScale(1)
            }}
          >
            {t('preview.actual')}
          </button>
        </span>
        <button
          type="button"
          className="mini"
          aria-label={t('preview.zoomOut')}
          disabled={shown <= 0.25}
          onClick={() => zoom(1 / 1.25)}
        >
          −
        </button>
        <span className="fp-scale">{Math.round(shown * 100)}%</span>
        <button
          type="button"
          className="mini"
          aria-label={t('preview.zoomIn')}
          disabled={shown >= 4}
          onClick={() => zoom(1.25)}
        >
          +
        </button>
        <span className="grow" />
        <span>
          {resource.width} × {resource.height}
        </span>
      </div>
      <div className="fp-image-stage" data-actual={actual}>
        {url ? (
          <img
            ref={image}
            src={url}
            style={
              actual
                ? { width: resource.width * scale, height: resource.height * scale }
                : undefined
            }
            alt={scope.path.split('/').pop() ?? ''}
            onError={fail}
          />
        ) : null}
      </div>
    </div>
  )
}
