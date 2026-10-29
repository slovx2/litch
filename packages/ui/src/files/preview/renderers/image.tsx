import { decodeBase64 } from '@litch/core'
import { useEffect, useMemo, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { imageInfo, svgInfo } from '../image-info.ts'

export default function ImagePreview({ data, scope, resources }: PreviewRendererProps) {
  const t = useT()
  const [actual, setActual] = useState(false)
  const [scale, setScale] = useState(1)
  const [failed, setFailed] = useState(false)
  const [url, setUrl] = useState('')
  const parsed = useMemo(() => {
    const bytes = decodeBase64(data.dataBase64)
    const info = data.format === 'svg' ? svgInfo(new TextDecoder().decode(bytes)) : imageInfo(bytes)
    return { bytes, info }
  }, [data])
  useEffect(() => {
    setFailed(false)
    if (
      !parsed.info ||
      !resources.claimPixels(scope.path, parsed.info.width * parsed.info.height)
    ) {
      setUrl('')
      setFailed(true)
      return
    }
    const made = URL.createObjectURL(
      new Blob([new Uint8Array(parsed.bytes)], { type: parsed.info.mime }),
    )
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [parsed, resources, scope.path])
  if (!parsed.info || failed)
    return (
      <div className="fv-hold" data-hold="invalidImage" role="status">
        <b>{t('files.view.group.image')}</b>
        <span>{t('preview.imageLimit')}</span>
      </div>
    )
  return (
    <div className="fp-image">
      <div className="fp-tools">
        <button
          type="button"
          className="mini"
          onClick={() => {
            setActual(!actual)
            setScale(1)
          }}
        >
          {t(actual ? 'preview.fit' : 'preview.actual')}
        </button>
        <button
          type="button"
          className="mini"
          aria-label={t('preview.zoomOut')}
          onClick={() => {
            setActual(true)
            setScale((n) => Math.max(0.25, n / 1.25))
          }}
        >
          −
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="mini"
          aria-label={t('preview.zoomIn')}
          onClick={() => {
            setActual(true)
            setScale((n) => Math.min(4, n * 1.25))
          }}
        >
          +
        </button>
        <span>
          {parsed.info.width} × {parsed.info.height}
        </span>
      </div>
      <div className="fp-image-stage" data-actual={actual}>
        {url ? (
          <img
            src={url}
            style={
              actual
                ? { width: parsed.info.width * scale, height: parsed.info.height * scale }
                : undefined
            }
            alt={scope.path.split('/').pop() ?? ''}
            onError={() => setFailed(true)}
          />
        ) : null}
      </div>
    </div>
  )
}
