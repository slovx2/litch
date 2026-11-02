// 议题在别处答复、关闭、忽略或取消后，本机草稿还在但不能提交：一行说明，可查看或丢弃（与桌面相同）。
import { type ReactNode, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

export function DraftEndedNote({
  id,
  text,
  onDiscard,
  children,
}: {
  id: string
  text: string
  onDiscard(): void
  children: ReactNode
}) {
  const t = useT()
  const { c, radius } = useTheme()
  const [open, setOpen] = useState(false)
  /** 点了“丢弃”，等再确认一次：丢了不能恢复 */
  const [discarding, setDiscarding] = useState(false)
  return (
    <View
      testID={`draft-ended:${id}`}
      role="status"
      style={[
        styles.note,
        { backgroundColor: c.sunken, borderLeftColor: c.wait, borderRadius: radius.s },
      ]}
    >
      <Text style={{ color: c.ink2 }}>{text}</Text>
      <View style={styles.actions}>
        <Button
          kind="plain"
          testID={`draft-ended-view:${id}`}
          label={t(open ? 'manager.draftHide' : 'manager.draftView')}
          onPress={() => setOpen(!open)}
        />
        {discarding ? null : (
          <Button
            kind="plain"
            testID={`draft-ended-discard:${id}`}
            label={t('manager.draftDiscard')}
            onPress={() => setDiscarding(true)}
          />
        )}
      </View>
      {discarding ? (
        <View testID={`draft-ended-discarding:${id}`} style={styles.discard}>
          <Text style={{ color: c.ink2 }}>{t('manager.draftDiscardNote')}</Text>
          <View style={styles.actions}>
            <Button kind="plain" label={t('manager.cancel')} onPress={() => setDiscarding(false)} />
            <Button
              testID={`draft-ended-discard-confirm:${id}`}
              label={t('manager.draftDiscardConfirm')}
              onPress={onDiscard}
            />
          </View>
        </View>
      ) : null}
      {open ? (
        <View
          testID={`draft-ended-preview:${id}`}
          style={[styles.preview, { borderColor: c.line1 }]}
        >
          {children}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  note: { borderLeftWidth: 3, padding: 12, gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preview: { borderTopWidth: 1, paddingTop: 8, gap: 6 },
  discard: { gap: 8 },
})
