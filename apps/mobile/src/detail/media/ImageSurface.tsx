import type { FilePreview } from '@litch/core'
import { useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { previewEvent } from '../../screens/files/preview/model'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { IMAGE_HTML } from '../../web/file-preview-html.generated'

const ORIGIN = 'https://file-preview.litch.invalid/'
/** 与文件页共用离线图片解码和捏合视口；CSP 与导航闸禁止任何网络和设备文件访问。 */
export function ImageSurface({
  data,
  thumbnail,
  onReady,
  onFail,
  claimPixels,
  onRaster,
  onClose,
}: {
  data: Extract<FilePreview, { kind: 'ready' }>
  thumbnail?: boolean
  onReady?(): void
  onFail(): void
  claimPixels?(width: number, height: number): boolean
  onRaster?(uri: string): void
  onClose?(): void
}) {
  const { c, font } = useTheme()
  const t = useT()
  const [zoom, setZoom] = useState<number | null>(null)
  const web = useRef<WebView>(null)
  const checkBudget = !!claimPixels
  const dismissOnTap = !!onClose
  const html = useMemo(() => {
    const config = JSON.stringify({
      data: data.dataBase64,
      name: data.path,
      format: data.format,
      background: c.sunken,
      thumbnail: !!thumbnail,
      checkBudget,
      dismissOnTap,
    }).replaceAll('<', '\\u003c')
    return IMAGE_HTML.replace('<body>', `<body><script>window.__litchPreview=${config}</script>`)
  }, [data, c.sunken, thumbnail, checkBudget, dismissOnTap])
  return (
    <View style={{ flex: 1 }}>
      {!thumbnail ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: c.panel,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('preview.zoomOut')}
            testID="media:zoom-out"
            onPress={() => web.current?.injectJavaScript('window.__litchImageZoom?.(0.8);true;')}
            style={{ padding: 12 }}
          >
            <Text style={{ color: c.ink, fontSize: font.size.title }}>−</Text>
          </Pressable>
          <Text testID="media:zoom-value" style={{ color: c.ink2, fontSize: font.size.meta }}>
            {zoom === null ? '—' : `${zoom}%`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('preview.zoomIn')}
            testID="media:zoom-in"
            onPress={() => web.current?.injectJavaScript('window.__litchImageZoom?.(1.25);true;')}
            style={{ padding: 12 }}
          >
            <Text style={{ color: c.ink, fontSize: font.size.title }}>+</Text>
          </Pressable>
        </View>
      ) : null}
      <WebView
        ref={web}
        source={{ html, baseUrl: ORIGIN }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={({ url }) =>
          [ORIGIN, 'about:blank', 'about:srcdoc'].includes(url)
        }
        onOpenWindow={() => {}}
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
        setBuiltInZoomControls={false}
        overScrollMode="never"
        textZoom={100}
        onError={onFail}
        onRenderProcessGone={onFail}
        onContentProcessDidTerminate={onFail}
        onMessage={({ nativeEvent }) => {
          try {
            const info = JSON.parse(nativeEvent.data)
            if (info.kind === 'dismiss' && !thumbnail && onClose) {
              onClose()
              return
            }
            if (
              info.kind === 'zoom' &&
              Number.isInteger(info.percent) &&
              info.percent >= 50 &&
              info.percent <= 800
            ) {
              setZoom(info.percent)
              return
            }
            if (
              info.kind === 'thumbnail' &&
              onRaster &&
              typeof info.uri === 'string' &&
              info.uri.length <= 1024 * 1024 &&
              /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(info.uri)
            ) {
              onRaster(info.uri)
              return
            }
            if (info.kind === 'imageInfo' && claimPixels) {
              const valid =
                Number.isFinite(info.width) &&
                Number.isFinite(info.height) &&
                info.width > 0 &&
                info.height > 0 &&
                info.width * info.height <= 4_000_000
              const allowed = valid && claimPixels(info.width, info.height)
              web.current?.injectJavaScript(`window.__litchImageAuthorize?.(${allowed});true;`)
              return
            }
          } catch {
            /* 无效消息交给共用状态解析器拒绝。 */
          }
          const event = previewEvent(nativeEvent.data)
          if (event?.kind === 'failed') onFail()
          if (event?.kind === 'ready') onReady?.()
        }}
        testID={thumbnail ? 'media:thumbnail-web' : 'media:fullscreen-web'}
        style={{ flex: 1, backgroundColor: c.sunken }}
      />
    </View>
  )
}
