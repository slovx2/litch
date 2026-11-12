import { decodeBase64, SHORT_MEDIA_PIXELS, SHORT_MEDIA_SECONDS } from '@litch/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../../app/appearance.ts'
import { Icon } from '../../../app/icons.tsx'
import { useFileWatching } from '../../content.ts'
import type { PreviewRendererProps } from '../contract.ts'
import { mediaType } from '../web/media.ts'
import '../web.css'

export default function MediaPreview({ data, scope }: PreviewRendererProps) {
  const t = useT()
  const watching = useFileWatching()
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState<'invalid' | 'duration' | 'size' | null>(null)
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const player = useRef<HTMLMediaElement | null>(null)
  useEffect(() => {
    if (!watching) player.current?.pause()
  }, [watching])
  const parsed = useMemo(() => {
    const bytes = decodeBase64(data.dataBase64)
    return { bytes, type: mediaType(scope.path, bytes) }
  }, [data, scope.path])
  useEffect(() => {
    setFailed(null)
    setPlaying(false)
    setReady(false)
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
      <div className="fv-hold" data-hold="invalid" role="status">
        <b>{t('files.view.failed')}</b>
        <span>
          {t(
            failed === 'duration'
              ? 'preview.media.duration'
              : failed === 'size'
                ? 'preview.media.size'
                : 'preview.media.invalid',
          )}
        </span>
      </div>
    )
  const props = {
    src: url || undefined,
    controls: false,
    preload: 'metadata' as const,
    autoPlay: false,
    disableRemotePlayback: true,
    controlsList: 'nodownload noremoteplayback',
    onError: () => setFailed('invalid'),
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onLoadedMetadata: () => {
      const element = player.current
      if (!element || !Number.isFinite(element.duration) || element.duration <= 0) {
        setFailed('invalid')
        return
      }
      if (element.duration > SHORT_MEDIA_SECONDS) {
        setFailed('duration')
        return
      }
      if (
        element instanceof HTMLVideoElement &&
        (element.videoWidth > 16_384 ||
          element.videoHeight > 16_384 ||
          element.videoWidth * element.videoHeight > SHORT_MEDIA_PIXELS)
      ) {
        setFailed('size')
        return
      }
      setReady(true)
    },
    ref: (element: HTMLMediaElement | null) => {
      player.current = element
    },
  }
  return (
    <div className="fp-web fp-media">
      <div className="fp-web-note">
        <button
          className="ibtn"
          type="button"
          data-media-play
          disabled={!ready}
          title={t(playing ? 'preview.media.pause' : 'preview.media.play')}
          aria-label={t(playing ? 'preview.media.pause' : 'preview.media.play')}
          onClick={() => {
            const element = player.current
            if (!element) return
            if (playing) element.pause()
            else void element.play().catch(() => setFailed('invalid'))
          }}
        >
          <Icon name={playing ? 'pause' : 'play'} small />
        </button>
        {t('preview.media.note')}
      </div>
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
