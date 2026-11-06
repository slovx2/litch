// biome-ignore-all lint/suspicious/noArrayIndexKey: Markdown 顶层块按正文中的位置标识。
import {
  type DeviceView,
  decodeBase64,
  type FilePreview,
  keys,
  transcriptImageTarget,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Linking, Modal, Pressable, Text, useWindowDimensions, View } from 'react-native'
import {
  type EnrichedMarkdownTextProps,
  EnrichedMarkdownText as NativeMarkdown,
} from 'react-native-enriched-markdown'
import { imageInfo } from '../../../../../packages/core/src/image-info.mts'
import { PreviewResources } from '../../../../../packages/ui/src/files/preview/resources'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Icon } from '../../ui/kit/Icon'
import { useTheme } from '../../ui/theme'
import { TranscriptContext, useTranscript } from '../context'
import { ImageSurface } from './ImageSurface'
import { type ImageSegment, mediaBlocks } from './segments'

export function EnrichedMarkdownText({
  markdown,
  streaming,
  ...props
}: EnrichedMarkdownTextProps & { streaming?: boolean }) {
  const channel = useChannel()
  const context = useContext(TranscriptContext)
  const connection = useKey<DeviceView>(keys.device(context?.deviceId ?? ''))?.connection
  const focused = useIsFocused()
  const blocks = useMemo(() => (markdown.includes('![') ? mediaBlocks(markdown) : []), [markdown])
  // 每条消息独立限额，切会话即取消；最多 4M 解码像素（约 16 MiB RGBA）。
  const [resources, setResources] = useState<PreviewResources | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 会话身份或焦点变化时撤销整份媒体资源
  useEffect(() => {
    const next = new PreviewResources(
      (scope, _format, signal) =>
        channel.command(
          'media.image',
          { deviceId: scope.deviceId, source: scope.path },
          { signal },
        ),
      4_000_000,
    )
    setResources(next)
    return () => next.dispose()
  }, [channel, context?.deviceId, context?.sessionId, focused, connection])
  const hasImages = blocks.some((block) => block.images.length)
  if (!hasImages) return <NativeMarkdown markdown={markdown} {...props} />
  return (
    <View onLayout={props.onLayout}>
      {blocks.map((block, index) => (
        <View key={index} style={{ marginBottom: block.text.trim() ? 8 : 0 }}>
          <NativeMarkdown
            {...props}
            containerStyle={undefined}
            onLayout={undefined}
            markdown={block.text}
          />
          {!streaming && focused && context && resources
            ? block.images.map((image, at) => (
                <MediaImage key={`${image.href}:${at}`} image={image} resources={resources} />
              ))
            : null}
        </View>
      ))}
    </View>
  )
}

function MediaImage({ image, resources }: { image: ImageSegment; resources: PreviewResources }) {
  const context = useTranscript()
  const target = transcriptImageTarget(image.href, context.scope)
  const path =
    target.kind === 'file' ? target.path : target.kind === 'external' ? target.href : null
  const t = useT()
  const { c, font, radius: r } = useTheme()
  const { height: screenHeight } = useWindowDimensions()
  const host = useRef<View>(null)
  const [visible, setVisible] = useState(false)
  const [data, setData] = useState<Extract<FilePreview, { kind: 'ready' }> | null>(null)
  const [uri, setUri] = useState('')
  const [ratio, setRatio] = useState(1.5)
  const [failure, setFailure] = useState<'failed' | 'tooLarge' | 'invalid' | null>(null)
  const [ready, setReady] = useState(false)
  const [full, setFull] = useState(false)
  useEffect(() => {
    if (visible) return
    // FlashList 预挂载的单元格不立刻下载；只有靠近屏幕时才读图片。
    const check = () =>
      host.current?.measureInWindow((_x, y, width, height) => {
        if (width > 0 && height > 0 && y + height >= -200 && y <= screenHeight + 200)
          setVisible(true)
      })
    check()
    const timer = setInterval(check, 400)
    return () => clearInterval(timer)
  }, [visible, screenHeight])
  useEffect(() => {
    if (!visible || !path) return
    let live = true
    setData(null)
    setUri('')
    setReady(false)
    setFailure(null)
    resources.load({ deviceId: context.deviceId, root: '', path }, 'image', true).then(
      (result) => {
        if (!live) return
        if (result.kind !== 'ready') {
          setFailure(result.kind === 'tooLarge' ? 'tooLarge' : 'failed')
          return
        }
        if (result.format === 'svg') {
          // 离线 WebView 先验证 SVG，并在解码前申请消息累计像素预算。
          setData(result)
          return
        }
        try {
          const bytes = decodeBase64(result.dataBase64)
          const info = bytes.length === result.bytes ? imageInfo(bytes) : null
          if (!info) {
            setFailure('invalid')
            return
          }
          if (!resources.claimPixels(path, info.width * info.height)) {
            setFailure('tooLarge')
            return
          }
          setRatio(info.width / info.height)
          setData(result)
          setUri(`data:${info.mime};base64,${result.dataBase64}`)
        } catch {
          setFailure('invalid')
        }
      },
      () => {
        if (live) setFailure('failed')
      },
    )
    return () => {
      live = false
    }
  }, [visible, path, resources, context.deviceId])
  const fail = () => {
    setFailure((previous) => previous ?? 'invalid')
    setData(null)
    setUri('')
    setFull(false)
  }
  const openFile = () => {
    if (/^https?:\/\//i.test(image.href)) void Linking.openURL(image.href)
    else context.openLink(image.href)
  }
  return (
    <View ref={host} collapsable={false} style={{ marginVertical: 6 }} testID="media:card">
      {data && !failure ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('media.enlarge', { name: image.alt || image.href })}
          testID={ready ? `media:thumbnail:${image.alt}` : 'media:thumbnail-loading'}
          onPress={() => ready && setFull(true)}
          style={{
            height: Math.min(240, 300 / ratio),
            maxWidth: '100%',
            borderRadius: r.m,
            overflow: 'hidden',
          }}
        >
          {data.format === 'svg' && !uri ? (
            <View pointerEvents="none" style={{ flex: 1 }}>
              <ImageSurface
                data={data}
                thumbnail
                onRaster={setUri}
                onReady={() => setReady(true)}
                onFail={fail}
                claimPixels={(width, height) => {
                  const allowed = resources.claimPixels(path ?? image.href, width * height)
                  if (!allowed) setFailure('tooLarge')
                  else setRatio(width / height)
                  return allowed
                }}
              />
            </View>
          ) : (
            <Image
              source={{ uri }}
              resizeMode="contain"
              onLoad={() => setReady(true)}
              onError={fail}
              style={{ width: '100%', height: '100%' }}
            />
          )}
        </Pressable>
      ) : (
        <Pressable
          testID={failure || !path ? `media:failure:${image.alt}` : 'media:thumbnail-loading'}
          onPress={openFile}
          accessibilityRole="link"
          style={{ borderWidth: 1, borderColor: c.line1, borderRadius: r.m, padding: 8 }}
        >
          <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
            {image.alt || image.href} ·{' '}
            {t(
              !path
                ? 'preview.invalid'
                : failure === 'tooLarge'
                  ? 'preview.imageTooLarge'
                  : failure
                    ? 'preview.imageInvalid'
                    : 'files.view.loading',
            )}
          </Text>
        </Pressable>
      )}
      {full && data ? (
        <Modal visible animationType="fade" onRequestClose={() => setFull(false)}>
          <View style={{ flex: 1, backgroundColor: c.panel, paddingTop: 40 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('viewer.close')}
              testID="media:close"
              onPress={() => setFull(false)}
              style={{ padding: 12, alignSelf: 'flex-end' }}
            >
              <Icon name="close" size={20} color={c.ink} />
            </Pressable>
            <ImageSurface data={data} onFail={fail} />
          </View>
        </Modal>
      ) : null}
    </View>
  )
}
