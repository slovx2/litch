// 可用于文件页和对话的短媒体播放器；不读取路径、不请求设备、不自动播放。
import type { ShortMediaType } from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { useT } from '../ui/i18n'
import { IconButton } from '../ui/kit/Icon'
import { useTheme } from '../ui/theme'
import { type ShortMediaEvent, shortMediaDocument, shortMediaEvent } from './short-media-document'

export interface ShortMediaProps {
  dataBase64: string
  type: ShortMediaType
  onFail(reason: Extract<ShortMediaEvent, { kind: 'failed' }>['reason']): void
  /** 播放条右端的操作（复制路径、存到手机），和播放键同一行，不另占一行 */
  actions?: ReactNode
}

export function ShortMedia({ dataBase64, type, onFail, actions }: ShortMediaProps) {
  const t = useT(),
    theme = useTheme(),
    focused = useIsFocused()
  const web = useRef<WebView>(null)
  const [ready, setReady] = useState(false),
    [playing, setPlaying] = useState(false)
  const html = useMemo(
    () => shortMediaDocument(dataBase64, type, theme.c.sunken),
    [dataBase64, type, theme.c.sunken],
  )
  const pause = useCallback(
    () => web.current?.injectJavaScript("window.__litchMedia?.('pause');true;"),
    [],
  )
  useEffect(() => {
    if (!focused) pause()
  }, [focused, pause])
  useEffect(() => {
    const close = AppState.addEventListener('change', (state) => {
      if (state !== 'active') pause()
    })
    return () => {
      close.remove()
      pause()
    }
  }, [pause])
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: theme.c.panel }}>
        <IconButton
          icon={playing ? 'pause' : 'play'}
          label={t(playing ? 'preview.media.pause' : 'preview.media.play')}
          testID="files:media-play"
          disabled={!ready}
          onPress={() =>
            web.current?.injectJavaScript(
              `window.__litchMedia?.('${playing ? 'pause' : 'play'}');true;`,
            )
          }
        />
        <Text
          numberOfLines={1}
          style={{ flex: 1, minWidth: 0, color: theme.c.ink3, fontSize: theme.font.size.meta }}
        >
          {t(ready ? 'preview.media.note' : 'mobilePreview.loading')}
        </Text>
        {actions}
      </View>
      <WebView
        source={{ html, baseUrl: 'https://short-media.litch.invalid/' }}
        ref={web}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={({ url }) =>
          ['https://short-media.litch.invalid/', 'about:blank', 'about:srcdoc'].includes(url)
        }
        javaScriptCanOpenWindowsAutomatically={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        javaScriptEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        onMessage={({ nativeEvent }) => {
          const event = shortMediaEvent(nativeEvent.data)
          if (event?.kind === 'ready') setReady(true)
          else if (event?.kind === 'playing') setPlaying(event.value)
          else if (event?.kind === 'failed') onFail(event.reason)
        }}
        onError={() => onFail('mediaInvalid')}
        onRenderProcessGone={() => onFail('mediaInvalid')}
        onContentProcessDidTerminate={() => onFail('mediaInvalid')}
        testID="files:short-media"
        style={{ flex: 1, backgroundColor: theme.c.sunken }}
      />
    </View>
  )
}
