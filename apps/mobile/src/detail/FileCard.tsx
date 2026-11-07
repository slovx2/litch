import {
  type AttachmentState,
  attachmentDetail,
  attachmentState,
  type DeviceView,
  keys,
  type UserAttachment,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useKey, useServices } from '../shell/services'
import { useT } from '../ui/i18n'
import { Icon } from '../ui/kit/Icon'
import { useTheme } from '../ui/theme'

export function FileCard({
  file,
  deviceId,
  onPress,
  onRemove,
}: {
  file: UserAttachment
  deviceId?: string | undefined
  onPress(): void
  onRemove?(): void
}) {
  const { c, radius, font } = useTheme()
  const t = useT()
  const { channel } = useServices()
  const device = useKey<DeviceView>(keys.device(deviceId ?? ''))
  const [state, setState] = useState<AttachmentState>('unknown')
  useEffect(() => {
    let active = true
    setState('unknown')
    if (device?.connection !== 'online') return
    void attachmentState(channel, deviceId, { path: file.path, client: file.client }).then(
      (next) => {
        if (active) setState(next)
      },
    )
    return () => {
      active = false
    }
  }, [channel, deviceId, file.path, file.client, device?.connection])
  const open = async () => {
    if (state === 'cleaned') return
    const next = await attachmentState(channel, deviceId, file)
    setState(next)
    if (next !== 'cleaned') onPress()
  }
  const name = file.label ?? t('attachment.file')
  const detail =
    file.kind === 'folder'
      ? t('attachment.folder')
      : attachmentDetail({ name, ...(file.size !== undefined ? { size: file.size } : {}) }) ||
        t('attachment.file')
  return (
    <View style={[styles.card, { borderColor: c.line2, borderRadius: radius.s }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={name}
        onPress={() => void open()}
        disabled={state === 'cleaned'}
        accessibilityState={{ disabled: state === 'cleaned' }}
        style={styles.open}
      >
        <Icon name={file.kind === 'folder' ? 'folder' : 'file'} size={18} color={c.ink2} />
        <View style={styles.info}>
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            style={{ color: c.ink, fontFamily: font.ui }}
          >
            {name}
          </Text>
          <Text numberOfLines={1} style={{ color: c.ink3, fontFamily: font.ui }}>
            {state === 'cleaned' ? t('attachment.cleaned') : detail}
          </Text>
        </View>
      </Pressable>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('composer.extra.remove', { name })}
          onPress={onRemove}
          hitSlop={4}
          style={styles.remove}
        >
          <Icon name="close" size={14} color={c.ink2} />
        </Pressable>
      ) : null}
    </View>
  )
}
const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    maxWidth: '100%',
    minWidth: 0,
    width: 240,
    marginBottom: 6,
  },
  open: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, flex: 1, minWidth: 0 },
  info: { flex: 1, minWidth: 0 },
  remove: { minWidth: 40, minHeight: 40, alignItems: 'center', justifyContent: 'center' },
})
