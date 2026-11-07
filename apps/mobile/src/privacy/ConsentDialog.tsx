import { useLayoutEffect, useState } from 'react'
import { Linking, Text } from 'react-native'
import { KeyboardController } from 'react-native-keyboard-controller'
import { useT } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { Dialog } from '../ui/kit/overlays'
import { useTheme } from '../ui/theme'
import { PRIVACY_URL } from './config'
import type { ConsentView } from './consent-access'
import { aiConsent } from './storage'

export function ConsentDialog({ view }: { view: ConsentView }) {
  const t = useT()
  const theme = useTheme()
  const [failed, setFailed] = useState(false)
  useLayoutEffect(() => {
    setFailed(false)
    if (view) void KeyboardController.dismiss().catch(() => {})
  }, [view])
  const answer = (allow: boolean) => {
    try {
      aiConsent.answer(allow)
    } catch {
      setFailed(true)
    }
  }
  const style = { color: theme.c.ink, fontFamily: theme.font.ui, fontSize: theme.font.size.body }
  return (
    <Dialog
      visible={view !== null}
      consentHost={false}
      // 遮罩、返回、应用挂起或承载点切换不代表用户拒绝，也不影响任何发送命令。
      onClose={() => {}}
      onRequestClose={() => {}}
    >
      <Text style={style} testID={view === 'required' ? 'ai-consent:required' : 'ai-consent:title'}>
        {t(view === 'required' ? 'privacy.ai.required' : 'privacy.ai.title')}
      </Text>
      {view === 'notice' ? (
        <>
          <Text style={style}>{t('privacy.ai.launchDetail')}</Text>
          <Text style={style}>{t('privacy.ai.launchServices')}</Text>
          <Text style={style}>{t('privacy.ai.launchScope')}</Text>
        </>
      ) : null}
      <Button
        kind="plain"
        label={t('app.privacy')}
        onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => {})}
      />
      {failed ? <Text style={style}>{t('privacy.ai.saveFailed')}</Text> : null}
      <Button
        kind="plain"
        label={t(view === 'required' ? 'app.done' : 'privacy.ai.decline')}
        testID="ai-consent:cancel"
        onPress={() => (view === 'required' ? aiConsent.close() : answer(false))}
      />
      <Button
        label={t(view === 'required' ? 'privacy.ai.review' : 'privacy.ai.allow')}
        testID={view === 'required' ? 'ai-consent:review' : 'ai-consent:allow'}
        onPress={() => (view === 'required' ? aiConsent.open() : answer(true))}
      />
    </Dialog>
  )
}
