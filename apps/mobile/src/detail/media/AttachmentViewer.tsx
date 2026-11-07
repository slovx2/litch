import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useT } from '../../ui/i18n'
import { Icon } from '../../ui/kit/Icon'
import { IMAGE_VIEWER_COLORS } from '../../ui/palettes'
import { attachmentGestures } from './attachment-gestures'

/** 附件图片全屏查看：单击关闭、双击放大、双指缩放；手势松手不作为单击。 */
export function ImageViewer({ url, onClose }: { url: string | null; onClose(): void }) {
  return url ? <Viewer key={url} url={url} onClose={onClose} /> : null
}

function Viewer({ url, onClose }: { url: string; onClose(): void }) {
  const t = useT()
  const insets = useSafeAreaInsets()
  const [position, setPosition] = useState({ x: 0, y: 0, scale: 1 })
  const close = useRef(onClose)
  close.current = onClose
  const gestures = useMemo(() => {
    const state = attachmentGestures(setPosition, () => close.current())
    return {
      cancel: state.cancel,
      responder: PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event) => state.grant(event.nativeEvent.touches),
        onPanResponderStart: (event) => state.add(event.nativeEvent.touches),
        onPanResponderMove: (event) => state.move(event.nativeEvent.touches),
        onPanResponderRelease: state.release,
        onPanResponderTerminationRequest: () => false,
        onPanResponderTerminate: state.cancel,
      }),
    }
  }, [])
  useEffect(() => gestures.cancel, [gestures])
  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.viewer} testID="image-viewer">
        <View style={StyleSheet.absoluteFill} {...gestures.responder.panHandlers}>
          <Image
            source={{ uri: url }}
            resizeMode="contain"
            style={[
              styles.full,
              {
                transform: [
                  { translateX: position.x },
                  { translateY: position.y },
                  { scale: position.scale },
                ],
              },
            ]}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('viewer.close')}
          onPress={onClose}
          testID="image-viewer-close"
          style={[styles.close, { top: insets.top + 8 }]}
        >
          <Icon name="close" size={24} color={IMAGE_VIEWER_COLORS.ink} />
        </Pressable>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  viewer: { flex: 1, backgroundColor: IMAGE_VIEWER_COLORS.background },
  full: { width: '100%', height: '100%' },
  close: { position: 'absolute', right: 8, padding: 12 },
})
