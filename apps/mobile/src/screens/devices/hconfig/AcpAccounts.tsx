import { ScrollView, StyleSheet, View } from 'react-native'
import { whyNot } from '../../../../../../packages/ui/src/app/errors.ts'
import { useAcpAuth } from '../../../../../../packages/ui/src/devices/hconfig/useAcpAuth.ts'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button } from '../../../ui/kit/controls'
import { Note } from './parts'

export function AcpAccounts({ deviceId, harness }: { deviceId: string; harness: string }) {
  const t = useT()
  const channel = useChannel()
  const { data, busy, error, methods, run } = useAcpAuth(channel, deviceId, harness)
  return (
    <ScrollView testID="hc:acp:accounts">
      <Note text={t('hc.acp.title')} />
      <Note
        testID="hc:acp:status"
        text={t(busy ? `hc.acp.${busy}` : `hc.acp.${data?.status ?? 'unknown'}`)}
      />
      <Note text={t('hc.acp.instruction')} tone="dim" />
      {error ? <Note text={t('hc.acp.failed', { reason: whyNot(error, t) })} /> : null}
      {data && methods.length === 0 ? <Note text={t('hc.acp.terminal')} /> : null}
      <View style={styles.actions}>
        {methods.map((method) => (
          <Button
            key={method.id}
            disabled={busy !== null}
            testID={`hc:acp:login:${method.id}`}
            label={t(method.id === 'oauth-business' ? 'hc.acp.business' : 'hc.acp.personal')}
            onPress={() => void run('login', method.id)}
          />
        ))}
        {data?.logout ? (
          <Button
            kind="plain"
            disabled={busy !== null || data.status === 'signedOut'}
            testID="hc:acp:logout"
            label={t('hc.acp.signOut')}
            onPress={() => void run('logout')}
          />
        ) : null}
        <Button
          kind="plain"
          disabled={busy !== null}
          testID="hc:acp:refresh"
          label={t('hc.acp.refresh')}
          onPress={() => void run('read')}
        />
      </View>
    </ScrollView>
  )
}
const styles = StyleSheet.create({ actions: { padding: 16, gap: 10 } })
