import {
  baseName,
  observeFileChanges,
  PREVIEW_LIMIT,
  type FilePreview as PreviewResult,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { byteSize } from '../../../../../../packages/ui/src/files/lines.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Empty } from '../../../ui/kit/controls'
import { useTheme } from '../../../ui/theme'
import { IMAGE_HTML, PDF_HTML } from '../../../web/file-preview-html.generated'
import {
  type MobilePreviewFormat,
  type PreviewFailure,
  previewEvent,
  previewFailure,
} from './model'
import { CopyPath, PreviewNotice } from './PreviewNotice'

type Ready = Extract<PreviewResult, { kind: 'ready' }>
type Loaded = { kind: 'loading' } | { kind: 'failed'; reason: PreviewFailure } | Ready
// Android WebView 拒绝 about:blank 下的 blob:null worker。此地址只提供来源，不发网络请求；
// HTML 仍直接传入，CSP 禁止连接，导航只放行内联文档本身。
const PREVIEW_ORIGIN = 'https://file-preview.litch.invalid/'

export function FilePreview({
  deviceId,
  root,
  path,
  format,
}: {
  deviceId: string
  root: string
  path: string
  format: MobilePreviewFormat
}) {
  const channel = useChannel()
  const focused = useIsFocused()
  const t = useT()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  // 切换文件、失焦或退出立即释放 base64 和 WebView；过期应答不能重新挂载旧文件。
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt 是用户重试次数
  useEffect(() => {
    let live = true
    const abort = new AbortController()
    setLoaded({ kind: 'loading' })
    const read = () =>
      channel
        .command('files.preview', { deviceId, root, path, format }, { signal: abort.signal })
        .then(
          (result) => {
            if (!live) return
            const reason = previewFailure(result, format)
            setLoaded(reason ? { kind: 'failed', reason } : (result as Ready))
          },
          () => {
            if (live) setLoaded({ kind: 'failed', reason: 'failed' })
          },
        )
    const close = focused
      ? observeFileChanges(channel, { deviceId, root, path }, read, true)
      : () => {}
    return () => {
      close()
      live = false
      abort.abort()
    }
  }, [channel, focused, deviceId, root, path, format, attempt])
  if (!focused || loaded.kind === 'loading') return <Empty title={t('mobilePreview.loading')} />
  if (loaded.kind === 'failed')
    return (
      <PreviewNotice
        path={path}
        detail={t(`mobilePreview.${loaded.reason}`, { limit: byteSize(PREVIEW_LIMIT[format]) })}
        retry={() => setAttempt((n) => n + 1)}
      />
    )
  return (
    <PreviewWeb
      key={`${path}:${attempt}`}
      data={loaded}
      format={format}
      onFail={(reason) => setLoaded({ kind: 'failed', reason })}
    />
  )
}

function PreviewWeb({
  data,
  format,
  onFail,
}: {
  data: Ready
  format: MobilePreviewFormat
  onFail(reason: PreviewFailure): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const insets = useSafeAreaInsets()
  const web = useRef<WebView>(null)
  const [page, setPage] = useState(0)
  const [pages, setPages] = useState(0)
  const [busy, setBusy] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const failRef = useRef(onFail)
  failRef.current = onFail
  const arm = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => failRef.current('timeout'), 25000)
  }, [])
  useEffect(() => {
    arm()
    return () => clearTimeout(timer.current)
  }, [arm])
  const html = useMemo(() => {
    const config = JSON.stringify({
      data: data.dataBase64,
      name: baseName(data.path),
      background: c.sunken,
    }).replaceAll('<', '\\u003c')
    return (format === 'image' ? IMAGE_HTML : PDF_HTML).replace(
      '<body>',
      `<body><script>window.__litchPreview=${config}</script>`,
    )
  }, [data, format, c.sunken])
  const turn = (number: number) => {
    setBusy(true)
    arm()
    web.current?.injectJavaScript(`window.__litchPage?.(${number});true;`)
  }
  return (
    <View style={styles.wrap}>
      <View style={[styles.toolbar, { backgroundColor: c.panel }]}>
        <Text style={{ color: c.ink2, fontSize: font.size.meta }}>{byteSize(data.bytes)}</Text>
        <CopyPath path={data.path} />
      </View>
      {format === 'pdf' ? (
        <View style={[styles.toolbar, { backgroundColor: c.panel }]}>
          <Button
            kind="plain"
            label={t('mobilePreview.previous')}
            testID="files:previous-page"
            disabled={busy || page <= 1}
            onPress={() => turn(page - 1)}
          />
          <Text testID="files:page" style={{ color: c.ink, fontSize: font.size.meta }}>
            {pages ? t('mobilePreview.page', { page, pages }) : '—'}
          </Text>
          <Button
            kind="plain"
            label={t('mobilePreview.next')}
            testID="files:next-page"
            disabled={busy || page >= pages}
            onPress={() => turn(page + 1)}
          />
        </View>
      ) : null}
      <WebView
        ref={web}
        source={{ html, baseUrl: PREVIEW_ORIGIN }}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={({ url }) =>
          url === PREVIEW_ORIGIN || url === 'about:blank' || url === 'about:srcdoc'
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
        onLoadStart={() => {
          setBusy(true)
          setPage(0)
          setPages(0)
          arm()
        }}
        onMessage={({ nativeEvent }) => {
          const event = previewEvent(nativeEvent.data)
          if (!event) return
          clearTimeout(timer.current)
          if (event.kind === 'failed') onFail(event.reason)
          else {
            setPage(event.page)
            setPages(event.pages)
            setBusy(false)
          }
        }}
        onError={() => onFail('invalid')}
        onRenderProcessGone={() => onFail('failed')}
        onContentProcessDidTerminate={() => onFail('failed')}
        testID="files:preview-web"
        style={[styles.wrap, { backgroundColor: c.sunken }]}
      />
      <Text
        testID={busy ? 'files:preview-loading' : 'files:preview-ready'}
        style={[
          styles.hint,
          {
            color: c.ink3,
            backgroundColor: c.panel,
            fontSize: font.size.small,
            paddingBottom: 10 + insets.bottom,
          },
        ]}
      >
        {t(busy ? 'mobilePreview.loading' : 'mobilePreview.hint')}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 4,
    gap: 8,
  },
  hint: { padding: 10, textAlign: 'center' },
})
