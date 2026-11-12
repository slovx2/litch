// 网页预览仍使用同一份播放器文档和事件协议，原生版本由 WebView 承载。
import type { ShortMediaType } from '@litch/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { useT } from '../ui/i18n'
import { IconButton } from '../ui/kit/Icon'
import { useTheme } from '../ui/theme'
import { type ShortMediaEvent, shortMediaDocument, shortMediaEvent } from './short-media-document'

export function ShortMedia({
  dataBase64,
  type,
  onFail,
}: {
  dataBase64: string
  type: ShortMediaType
  onFail(reason: Extract<ShortMediaEvent, { kind: 'failed' }>['reason']): void
}) {
  const t = useT(),
    theme = useTheme()
  const frame = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false),
    [playing, setPlaying] = useState(false)
  const html = useMemo(
    () => shortMediaDocument(dataBase64, type, theme.c.sunken),
    [dataBase64, type, theme.c.sunken],
  )
  useEffect(() => {
    const receive = (message: MessageEvent) => {
      if (message.source !== frame.current?.contentWindow || typeof message.data !== 'string')
        return
      const event = shortMediaEvent(message.data)
      if (event?.kind === 'ready') setReady(true)
      else if (event?.kind === 'playing') setPlaying(event.value)
      else if (event?.kind === 'failed') onFail(event.reason)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [onFail])
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: theme.c.panel }}>
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={t(playing ? 'preview.media.pause' : 'preview.media.play')}
          testID="files:media-play"
          disabled={!ready}
          onPress={() =>
            frame.current?.contentWindow?.postMessage(
              { litchShortMedia: true, action: playing ? 'pause' : 'play' },
              '*',
            )
          }
        />
        <Text style={{ color: theme.c.ink3, fontSize: theme.font.size.meta }}>
          {t(ready ? 'preview.media.note' : 'mobilePreview.loading')}
        </Text>
      </View>
      <iframe
        title={t(type.kind === 'audio' ? 'preview.media.audio' : 'preview.media.video')}
        ref={frame}
        srcDoc={html}
        sandbox="allow-scripts"
        allow="autoplay"
        style={{ flex: 1, width: '100%', border: 0, background: theme.c.sunken }}
      />
    </View>
  )
}
