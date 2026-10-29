import { decodeBase64 } from '@litch/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { mediaType } from '../web/media.ts'
import '../web.css'

export default function MediaPreview({ data, scope }: PreviewRendererProps) {
  const t = useT()
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  const player = useRef<HTMLMediaElement | null>(null)
  const parsed = useMemo(() => {
    const bytes = decodeBase64(data.dataBase64)
    return { bytes, type: mediaType(scope.path, bytes) }
  }, [data, scope.path])
  useEffect(() => {
    setFailed(false)
    setUrl('')
    if (!parsed.type) return
    const made = URL.createObjectURL(
      new Blob([new Uint8Array(parsed.bytes)], { type: parsed.type.mime }),
    )
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [parsed])
  // biome-ignore lint/correctness/useExhaustiveDependencies: src 更新或播放器移除时停止旧元素。
  useEffect(() => {
    const element = player.current
    return () => {
      if (!element) return
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [url, failed])
  if (!parsed.type || failed)
    return (
      <div className="fv-hold" role="status">
        <span>{t('preview.media.invalid')}</span>
      </div>
    )
  const props = {
    src: url || undefined,
    controls: true,
    preload: 'metadata' as const,
    autoPlay: false,
    disableRemotePlayback: true,
    controlsList: 'nodownload noremoteplayback',
    onError: () => setFailed(true),
    onLoadedMetadata: () => {
      const element = player.current
      if (!element || !Number.isFinite(element.duration) || element.duration <= 0) setFailed(true)
      if (
        element instanceof HTMLVideoElement &&
        (element.videoWidth > 16_384 ||
          element.videoHeight > 16_384 ||
          element.videoWidth * element.videoHeight > 20_000_000)
      )
        setFailed(true)
    },
    ref: (element: HTMLMediaElement | null) => {
      player.current = element
    },
  }
  return (
    <div className="fp-web fp-media">
      <div className="fp-web-note">{t('preview.media.note')}</div>
      <div className="fp-media-stage">
        {url ? (
          parsed.type.kind === 'audio' ? (
            <audio {...props} aria-label={t('preview.media.audio')} />
          ) : (
            <video
              {...props}
              aria-label={t('preview.media.video')}
              playsInline
              disablePictureInPicture
            />
          )
        ) : null}
      </div>
    </div>
  )
}
