import { attachmentDetail, type UserAttachment } from '@litch/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useT } from '../ui/i18n'
import { useTheme } from '../ui/theme'

export function FileCard({
  file,
  onPress,
  onRemove,
}: {
  file: UserAttachment
  onPress(): void
  onRemove?(): void
}) {
  const { c, radius, font } = useTheme()
  const t = useT()
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
        onPress={onPress}
        style={styles.open}
      >
        <Text style={{ color: c.ink2, fontSize: font.size.body }}>
          {file.kind === 'folder' ? '▱' : '▤'}
        </Text>
        <View style={styles.info}>
          <Text
            numberOfLines={1}
            ellipsizeMode="middle"
            style={{ color: c.ink, fontFamily: font.ui }}
          >
            {name}
          </Text>
          <Text numberOfLines={1} style={{ color: c.ink3, fontFamily: font.ui }}>
            {detail}
          </Text>
        </View>
      </Pressable>
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('composer.extra.remove', { name })}
          onPress={onRemove}
          style={styles.remove}
        >
          <Text style={{ color: c.ink2 }}>✕</Text>
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
  remove: { padding: 10 },
})
