import { decodeBase64 } from '@litch/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { imageInfo, svgInfo } from '../image-info.ts'

export default function ImagePreview({ data, scope, resources }: PreviewRendererProps) {
  const t = useT()
  const [actual, setActual] = useState(false)
  const [scale, setScale] = useState(1)
  /** 适应宽度时图实际画出来的比例，工具条上写的是它，放大缩小也从它起步 */
  const [fitScale, setFitScale] = useState(1)
  const [failed, setFailed] = useState<MessageKey | null>(null)
  const image = useRef<HTMLImageElement>(null)
  const [url, setUrl] = useState('')
  const parsed = useMemo(() => {
    const bytes = decodeBase64(data.dataBase64)
    const info = data.format === 'svg' ? svgInfo(new TextDecoder().decode(bytes)) : imageInfo(bytes)
    return { bytes, info }
  }, [data])
  useEffect(() => {
    setFailed(null)
    if (!parsed.info) {
      setUrl('')
      setFailed('preview.imageInvalid')
      return
    }
    if (!resources.claimPixels(scope.path, parsed.info.width * parsed.info.height)) {
      setUrl('')
      setFailed('preview.imageBudget')
      return
    }
    const made = URL.createObjectURL(
      new Blob([new Uint8Array(parsed.bytes)], { type: parsed.info.mime }),
    )
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [parsed, resources, scope.path])
  const width = parsed.info?.width ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: 图在有了 url 之后才挂上，那时才量得到
  useEffect(() => {
    const element = image.current
    if (actual || !element || !width) return
    const measure = () => setFitScale(element.clientWidth / width || 1)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [actual, url, width])
  if (!parsed.info || failed)
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
          {parsed.info.width} × {parsed.info.height}
        </span>
      </div>
      <div className="fp-image-stage" data-actual={actual}>
        {url ? (
          <img
            ref={image}
            src={url}
            style={
              actual
                ? { width: parsed.info.width * scale, height: parsed.info.height * scale }
                : undefined
            }
            alt={scope.path.split('/').pop() ?? ''}
            onError={() => setFailed('preview.imageInvalid')}
          />
        ) : null}
      </div>
    </div>
  )
}
