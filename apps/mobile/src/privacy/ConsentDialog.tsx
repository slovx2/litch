import { useLayoutEffect, useMemo } from 'react'
import { Keyboard, Linking, Text } from 'react-native'
import { KeyboardController } from 'react-native-keyboard-controller'
import { useT } from '../ui/i18n'
import { Button } from '../ui/kit/controls'
import { Dialog } from '../ui/kit/overlays'
import { useTheme } from '../ui/theme'
import { PRIVACY_URL } from './config'
import { type ConsentRequest, consentKey } from './consent'
import { consentKeyboard } from './consent-keyboard'

export function ConsentDialog({ request }: { request: ConsentRequest | null }) {
  const t = useT()
  const theme = useTheme()
  const keyboard = useMemo(
    () =>
      consentKeyboard({
        visible: () => Keyboard.isVisible(),
        dismiss: () => KeyboardController.dismiss(),
        cancel: () => request?.answer(false),
      }),
    [request],
  )
  useLayoutEffect(() => {
    if (request) void keyboard.hide()
  }, [request, keyboard])
  const style = { color: theme.c.ink, fontFamily: theme.font.ui, fontSize: theme.font.size.body }
  return (
    <Dialog
      visible={request !== null}
      consentHost={false}
      onClose={() => request?.answer(false)}
      onRequestClose={() => void keyboard.back()}
    >
      <Text style={style} testID="ai-consent:title">
        {t('privacy.ai.title')}
      </Text>
      <Text style={style}>
        {t(
          request?.targets[0]?.provider === 'attachment-upload'
            ? 'privacy.ai.upload'
            : 'privacy.ai.detail',
        )}
      </Text>
      <Text style={style}>{t('privacy.ai.remote')}</Text>
      {request?.targets.map((target) => (
        <Text key={consentKey(target)} style={style}>
          {target.device} · {target.harness}
          {'\n'}
          {target.label}
          {target.model ? ` · ${target.model}` : ''}
        </Text>
      ))}
      {request?.targets.some(
        (target) => !target.remember && target.provider !== 'attachment-upload',
      ) ? (
        <Text style={style}>{t('privacy.ai.unknown')}</Text>
      ) : null}
      {request?.targets.some((target) => target.delegated) ? (
        <Text style={style}>{t('privacy.ai.delegate')}</Text>
      ) : null}
      <Button
        kind="plain"
        label={t('app.privacy')}
        onPress={() => void Linking.openURL(PRIVACY_URL).catch(() => {})}
      />
      <Button
        kind="plain"
        label={t('app.cancel')}
        testID="ai-consent:cancel"
        onPress={() => request?.answer(false)}
      />
      <Button
        label={t('privacy.ai.allow')}
        testID="ai-consent:allow"
        onPress={() => request?.answer(true)}
      />
    </Dialog>
  )
}
