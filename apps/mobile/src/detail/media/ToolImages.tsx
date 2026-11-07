import {
  type DeviceView,
  type FilePreview,
  keys,
  TOOL_IMAGE_PREFIX,
  type ToolImage,
} from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import { useEffect, useState } from 'react'
import { Image, Modal, Pressable, Text, useWindowDimensions, View } from 'react-native'
import { useChannel, useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { useTheme } from '../../ui/theme'
import { useTranscript } from '../context'
import { ImageSurface } from './ImageSurface'

/** 手机沿用 Claude 窄屏图条：只露最后一张，+N 打开同组图库。 */
export function ToolImages({
  images,
  gallery = images,
}: {
  images: ToolImage[]
  gallery?: ToolImage[]
}) {
  const { deviceId } = useTranscript()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const { c, font, hit, radius } = useTheme()
  const focused = useIsFocused()
  const { width } = useWindowDimensions()
  const t = useT()
  const [index, select] = useState<number | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 离开页面、断线或关闭隐私开关时撤销当前原图。
  useEffect(() => {
    select(null)
  }, [focused, device?.toolImagesEnabled, device?.connection])
  if (!images.length || device?.toolImagesEnabled === false || !focused) return null
  const visible = images.slice(width < 640 ? -1 : -3)
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          marginLeft: 'auto',
          paddingHorizontal: 8,
        }}
        testID="tool-images"
      >
        {images.length > visible.length ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => select(0)}
            style={{ minHeight: hit, justifyContent: 'center' }}
          >
            <Text style={{ color: c.ink3, fontSize: font.size.meta }}>
              +{images.length - visible.length}
            </Text>
          </Pressable>
        ) : null}
        {visible.map((image) => (
          <Pressable
            key={image.id}
            accessibilityRole="button"
            accessibilityLabel={t('tool.image.view')}
            testID="tool-image-open"
            onPress={() =>
              select(
                Math.max(
                  0,
                  gallery.findIndex((entry) => entry.id === image.id),
                ),
              )
            }
            style={{ minHeight: hit, justifyContent: 'center' }}
          >
            {image.thumbnail ? (
              <Image
                source={{ uri: `data:image/png;base64,${image.thumbnail.dataBase64}` }}
                style={{
                  height: 24,
                  width: Math.min(44, (24 * image.width) / image.height),
                  borderRadius: radius.s,
                }}
                resizeMode="cover"
              />
            ) : (
              <Text style={{ color: c.ink3 }}>▧</Text>
            )}
          </Pressable>
        ))}
      </View>
      {index !== null && gallery[index] ? (
        <Modal visible animationType="fade" onRequestClose={() => select(null)}>
          <View style={{ flex: 1, backgroundColor: c.panel, paddingTop: 40 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('viewer.close')}
              testID="tool-image-close"
              onPress={() => select(null)}
              style={{ alignSelf: 'flex-end', padding: 16 }}
            >
              <Text style={{ color: c.ink, fontSize: font.size.title }}>×</Text>
            </Pressable>
            <Original
              key={gallery[index]!.id}
              deviceId={deviceId}
              image={gallery[index]!}
              onClose={() => select(null)}
            />
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                alignItems: 'center',
                gap: 24,
                padding: 16,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('media.previous')}
                disabled={index === 0}
                onPress={() => select(index - 1)}
                style={{ padding: 12, opacity: index === 0 ? 0.3 : 1 }}
              >
                <Text style={{ color: c.ink }}>←</Text>
              </Pressable>
              <Text style={{ color: c.ink }}>
                {index + 1} / {gallery.length}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('media.next')}
                disabled={index === gallery.length - 1}
                onPress={() => select(index + 1)}
                style={{ padding: 12, opacity: index === gallery.length - 1 ? 0.3 : 1 }}
              >
                <Text style={{ color: c.ink }}>→</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  )
}

function Original({
  deviceId,
  image,
  onClose,
}: {
  deviceId: string
  image: ToolImage
  onClose(): void
}) {
  const channel = useChannel()
  const t = useT()
  const { c } = useTheme()
  const [data, setData] = useState<Extract<FilePreview, { kind: 'ready' }> | null>(null)
  const [failed, fail] = useState(false)
  const large = image.width * image.height > 4_000_000
  useEffect(() => {
    if (large) return
    const abort = new AbortController()
    void channel
      .command(
        'media.image',
        { deviceId, source: TOOL_IMAGE_PREFIX + image.id },
        { signal: abort.signal },
      )
      .then(
        (result) => {
          if (abort.signal.aborted) return
          if (result.kind === 'ready') setData(result)
          else fail(true)
        },
        () => {
          if (!abort.signal.aborted) fail(true)
        },
      )
    return () => abort.abort()
  }, [channel, deviceId, image.id, large])
  if (large || failed || !data)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: c.ink2 }}>
          {t(large ? 'preview.imageTooLarge' : failed ? 'files.view.failed' : 'files.view.loading')}
        </Text>
      </View>
    )
  return (
    <ImageSurface
      data={data}
      onClose={onClose}
      onFail={() => fail(true)}
      claimPixels={(w, h) => w * h <= 4_000_000}
    />
  )
}
