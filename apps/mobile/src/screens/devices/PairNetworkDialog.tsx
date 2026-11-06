import { Text } from 'react-native'
import type { PairNetworkPrompt } from '../../platform/pair-network'
import { useT } from '../../ui/i18n'
import { Button } from '../../ui/kit/controls'
import { Dialog } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

export function PairNetworkDialog({
  prompt,
  identity,
  onContinue,
  onLogin,
  onClose,
}: {
  prompt: PairNetworkPrompt
  identity: string
  onContinue(direct: boolean): void
  onLogin(change: boolean): void
  onClose(): void
}) {
  const t = useT()
  const { c, font } = useTheme()
  const account = prompt === 'account'
  return (
    <Dialog visible={prompt !== null} onClose={onClose}>
      <Text style={{ color: c.ink, fontFamily: font.ui, fontSize: font.size.title }}>
        {t('pair.network.title')}
      </Text>
      <Text style={{ color: c.ink2, fontFamily: font.ui, fontSize: font.size.body }}>
        {t(account ? 'pair.network.account' : 'pair.network.login', { identity })}
      </Text>
      <Button
        label={t(account ? 'pair.network.correct' : 'pair.network.signIn')}
        testID="pair:network:primary"
        onPress={() => (account ? onContinue(false) : onLogin(false))}
      />
      <Button
        kind="plain"
        label={t(account ? 'pair.network.switch' : 'pair.network.direct')}
        testID="pair:network:secondary"
        onPress={() => (account ? onLogin(true) : onContinue(true))}
      />
    </Dialog>
  )
}
