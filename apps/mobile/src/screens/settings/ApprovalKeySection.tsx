// 设置里的“批准登录”：这部手机批准钥匙的指纹（电脑设置“已绑定的手机”里显示同一串，两边能对）。
// 钥匙第一次要用时才生成（platform/approval-key.ts）；还没有的可以在这里先生成一把，好在第一次批准前就对一下指纹。
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import { type ApprovalKeyInfo, approvalKeyInfo, ensureApprovalKey } from '../../platform/approval-key'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

export function ApprovalKeySection() {
  const t = useT()
  const theme = useTheme()
  const { c } = theme
  const [info, setInfo] = useState<ApprovalKeyInfo | null>(approvalKeyInfo)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const make = () => {
    setBusy(true)
    setError(null)
    ensureApprovalKey()
      .then(setInfo, (failure: unknown) => setError(whyNot(failure, t)))
      .finally(() => setBusy(false))
  }
  return (
    <View
      testID="settings:approval-key"
      style={[styles.box, { backgroundColor: c.panel, borderColor: c.line2 }]}
    >
      {info ? (
        <>
          <Text style={{ color: c.ink2 }}>{t('approval.settings.fingerprint')}</Text>
          <Text
            selectable
            testID="settings:approval-key:fingerprint"
            style={[styles.print, { color: c.ink, fontFamily: theme.font.mono }]}
          >
            {info.fingerprint}
          </Text>
        </>
      ) : (
        <>
          <Text style={{ color: c.ink2 }}>{t('approval.settings.none')}</Text>
          <View style={styles.make}>
            <Button
              testID="settings:approval-key:make"
              kind="plain"
              label={t('approval.settings.make')}
              busy={busy}
              onPress={make}
            />
          </View>
        </>
      )}
      {error ? <Text style={{ color: c.err }}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderTopWidth: 1, borderBottomWidth: 1, padding: 16, gap: 6 },
  print: { fontSize: 17, letterSpacing: 1 },
  make: { alignItems: 'flex-start' },
})
