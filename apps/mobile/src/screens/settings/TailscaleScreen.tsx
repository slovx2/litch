import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { savedRemotes } from '../../platform/device-store'
import {
  type TailscaleStatus,
  tailscale,
  tailscaleAvailable,
  tailscaleErrorKey,
} from '../../platform/tailscale'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field, Row } from '../../ui/kit/controls'
import { Confirm } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Tailscale'>

export function TailscaleScreen({ navigation, route }: Props) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const focused = useIsFocused()
  const available = tailscaleAvailable()
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [server, setServer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'logout' | 'clear' | null>(null)
  const edited = useRef(false)
  const connected = useRef(false)
  const alive = useRef(true)
  const refreshing = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const accept = useCallback(
    (next: TailscaleStatus) => {
      if (!alive.current) return
      setStatus(next)
      if (!edited.current)
        setServer(next.controlURL === 'https://controlplane.tailscale.com' ? '' : next.controlURL)
      if (next.state === 'connected' && !connected.current) {
        for (const device of savedRemotes()) {
          if (device.target.kind === 'host' && device.target.tailscale) {
            void channel.command('device.reconnect', { deviceId: device.id }).catch(() => {})
          }
        }
      }
      connected.current = next.state === 'connected'
    },
    [channel],
  )
  const refresh = useCallback(async () => {
    if (!available || refreshing.current) return
    refreshing.current = true
    try {
      accept(await tailscale.status())
    } catch (failed) {
      if (alive.current) setError(t(tailscaleErrorKey(failed) ?? 'tailscale.error.other'))
    } finally {
      refreshing.current = false
    }
  }, [available, accept, t])
  useEffect(() => {
    if (!focused || !available) return
    void refresh()
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') void refresh()
    }, 1500)
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh()
    })
    return () => {
      clearInterval(timer)
      subscription.remove()
    }
  }, [focused, available, refresh])
  const act = async (action: 'login' | 'logout' | 'clear') => {
    setError(null)
    setBusy(true)
    try {
      if (action === 'login') accept(await tailscale.login(server))
      else {
        await tailscale[action]()
        if (action === 'clear') {
          edited.current = false
          setServer('')
        }
        accept(await tailscale.status())
      }
    } catch (failed) {
      if (alive.current) setError(t(tailscaleErrorKey(failed) ?? 'tailscale.error.other'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const note = { color: theme.c.ink2, fontFamily: theme.font.ui, fontSize: theme.font.size.body }
  return (
    <Screen title={t('tailscale.title')} testID="tailscale">
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={note}>{t('tailscale.scope')}</Text>
        {!available ? (
          <Text style={note} testID="tailscale:unavailable">
            {t('tailscale.unavailable')}
          </Text>
        ) : (
          <>
            <Text
              style={[note, { color: status?.state === 'connected' ? theme.c.ok : theme.c.ink }]}
              testID="tailscale:state"
            >
              {t(`tailscale.state.${status?.state ?? 'stopped'}`)}
            </Text>
            {status?.hostname ? <Row title={t('tailscale.node')} detail={status.hostname} /> : null}
            {status?.tailnet ? (
              <Row title={t('tailscale.tailnet')} detail={status.tailnet} />
            ) : null}
            <Field
              label={t('tailscale.control')}
              hint={t('tailscale.control.hint')}
              value={server}
              onChangeText={(value) => {
                edited.current = true
                setServer(value)
              }}
              keyboardType="url"
              testID="tailscale:control"
            />
            <View style={styles.actions}>
              {status?.state !== 'connected' ? (
                <Button
                  label={`↗ ${t('tailscale.login')}`}
                  busy={busy}
                  testID="tailscale:login"
                  onPress={() => void act('login')}
                />
              ) : null}
              <Button
                label={`↻ ${t('tailscale.refresh')}`}
                kind="plain"
                onPress={() => void refresh()}
                testID="tailscale:refresh"
              />
            </View>
            {status?.authURL && status.state !== 'connected' ? (
              <Button
                label={`↗ ${t('tailscale.open')}`}
                testID="tailscale:open"
                onPress={() =>
                  void Linking.openURL(status.authURL).catch(() =>
                    setError(t('tailscale.error.other')),
                  )
                }
              />
            ) : null}
            <View style={styles.actions}>
              <Button
                label={`↪ ${t('tailscale.logout')}`}
                kind="plain"
                disabled={busy || !status || status.state === 'stopped'}
                onPress={() => setConfirm('logout')}
                testID="tailscale:logout"
              />
              <Button
                label={`× ${t('tailscale.clear')}`}
                kind="danger"
                disabled={busy}
                onPress={() => setConfirm('clear')}
                testID="tailscale:clear"
              />
            </View>
          </>
        )}
        {error ? (
          <Text style={[note, { color: theme.c.err }]} testID="tailscale:error">
            {error}
          </Text>
        ) : null}
        {route.params?.adding ? (
          <Button
            kind="plain"
            label={`← ${t('tailscale.back')}`}
            onPress={() => navigation.goBack()}
            testID="tailscale:back"
          />
        ) : null}
      </ScrollView>
      <Confirm
        visible={confirm !== null}
        danger
        title={t(confirm === 'logout' ? 'tailscale.logout' : 'tailscale.clear')}
        detail={t(confirm === 'logout' ? 'tailscale.logout.detail' : 'tailscale.clear.detail')}
        confirmLabel={t(confirm === 'logout' ? 'tailscale.logout' : 'tailscale.clear')}
        onConfirm={() => {
          if (confirm) void act(confirm)
        }}
        onClose={() => setConfirm(null)}
      />
    </Screen>
  )
}
const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 40, gap: 16 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
})
