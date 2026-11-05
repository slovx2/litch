import { type DeviceView, keys } from '@litch/core'
import { useIsFocused } from '@react-navigation/native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking, StyleSheet, Text, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { savedRemotes } from '../../platform/device-store'
import {
  type TailscaleStatus,
  tailscale,
  tailscaleAvailable,
  tailscaleErrorKey,
} from '../../platform/tailscale'
import { loginTailscale } from '../../platform/tailscale-login'
import { useChannel, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field, Row } from '../../ui/kit/controls'
import { KeyboardFormScrollView } from '../../ui/kit/KeyboardForm'
import { Confirm, Dialog } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Tailscale'>

export function TailscaleScreen({ navigation, route }: Props) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const replica = useReplica()
  const focused = useIsFocused()
  const available = tailscaleAvailable()
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [server, setServer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const login = useRef<AbortController | null>(null)
  const [confirm, setConfirm] = useState<'logout' | 'clear' | null>(null)
  const [disclosure, setDisclosure] = useState(false)
  const edited = useRef(false)
  const connected = useRef(false)
  const alive = useRef(true)
  const refreshing = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      login.current?.abort()
    }
  }, [])
  const accept = useCallback(
    (next: TailscaleStatus) => {
      if (!alive.current) return
      setStatus(next)
      if (next.state === 'connected' || next.state === 'needsApproval') {
        setWaiting(false)
        setError(null)
      }
      if (!edited.current)
        setServer(next.controlURL === 'https://controlplane.tailscale.com' ? '' : next.controlURL)
      if (next.state === 'connected' && !connected.current) {
        for (const device of savedRemotes()) {
          if (device.target.kind === 'host' && device.target.tailscale !== 'never') {
            if (replica.store.get<DeviceView>(keys.device(device.id))?.connection === 'online')
              continue
            void channel.command('device.reconnect', { deviceId: device.id }).catch(() => {})
          }
        }
      }
      connected.current = next.state === 'connected'
    },
    [channel, replica],
  )
  const refresh = useCallback(async () => {
    if (!available || refreshing.current || login.current) return
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
      if (action === 'login') {
        const controller = new AbortController()
        login.current = controller
        await loginTailscale(server, {
          signal: controller.signal,
          accept,
          open: async (url) => {
            await Linking.openURL(url)
            if (alive.current) setWaiting(true)
          },
        })
      } else {
        setWaiting(false)
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
      login.current = null
      if (alive.current) setBusy(false)
    }
  }
  const note = { color: theme.c.ink2, fontFamily: theme.font.ui, fontSize: theme.font.size.body }
  return (
    <Screen title={t('tailscale.title')} testID="tailscale">
      <KeyboardFormScrollView contentContainerStyle={styles.body}>
        <Dialog visible={disclosure} onClose={() => setDisclosure(false)}>
          <Text style={note}>{t('privacy.tailscale.title')}</Text>
          <Text style={note}>{t('privacy.tailscale.detail')}</Text>
          <Text style={note}>{server || 'https://controlplane.tailscale.com'}</Text>
          {server ? <Text style={note}>{t('privacy.tailscale.custom')}</Text> : null}
          <Button
            kind="plain"
            label={t('privacy.tailscale.policy')}
            onPress={() =>
              void Linking.openURL('https://tailscale.com/privacy-policy').catch(() =>
                setError(t('app.openLinkFailed')),
              )
            }
          />
          <Button
            kind="plain"
            label={t('app.cancel')}
            testID="tailscale:consent-cancel"
            onPress={() => setDisclosure(false)}
          />
          <Button
            label={t('privacy.continue')}
            testID="tailscale:consent-allow"
            onPress={() => {
              setDisclosure(false)
              void act('login')
            }}
          />
        </Dialog>
        {!available ? (
          <Text style={note} testID="tailscale:unavailable">
            {t('tailscale.unavailable')}
          </Text>
        ) : (
          <>
            <View
              style={[
                styles.card,
                {
                  backgroundColor: theme.c.panel,
                  borderColor: theme.c.line1,
                  borderRadius: theme.radius.m,
                },
              ]}
            >
              <Text
                style={[note, { color: status?.state === 'connected' ? theme.c.ok : theme.c.ink }]}
                testID="tailscale:state"
              >
                {status ? t(`tailscale.state.${status.state}`) : t('tailscale.checking')}
              </Text>
              {status?.hostname ? (
                <Identity label={t('tailscale.node')} value={status.hostname} />
              ) : null}
              {status?.tailnet ? (
                <Identity label={t('tailscale.tailnet')} value={status.tailnet} />
              ) : null}
            </View>
            <Text style={note}>{t('tailscale.scope')}</Text>
            {status?.state === 'needsApproval' ? (
              <Text style={note}>{t('tailscale.error.approval')}</Text>
            ) : null}
            {busy || waiting ? (
              <Text style={note} testID="tailscale:progress">
                {t(busy ? 'tailscale.preparing' : 'tailscale.waiting')}
              </Text>
            ) : null}
            <View style={styles.actions}>
              {status && status.state !== 'connected' && status.state !== 'needsApproval' ? (
                <Button
                  label={`↗ ${t(waiting ? 'tailscale.open' : 'tailscale.login')}`}
                  busy={busy}
                  testID="tailscale:login"
                  onPress={() => {
                    if (waiting && status.authURL)
                      void Linking.openURL(status.authURL).catch(() =>
                        setError(t('tailscale.error.other')),
                      )
                    else setDisclosure(true)
                  }}
                />
              ) : null}
              <Button
                label={`↻ ${t('tailscale.refresh')}`}
                kind="plain"
                disabled={busy}
                onPress={() => void refresh()}
                testID="tailscale:refresh"
              />
            </View>
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
            <Row
              title={t('tailscale.control')}
              left={<Text style={note}>{advanced ? '▾' : '▸'}</Text>}
              onPress={() => setAdvanced(!advanced)}
              testID="tailscale:advanced"
            />
            {advanced ? (
              <Field
                label={t('tailscale.control')}
                hint={t('tailscale.control.hint')}
                value={server}
                onChangeText={(value) => {
                  edited.current = true
                  setServer(value)
                }}
                editable={!busy}
                keyboardType="url"
                testID="tailscale:control"
              />
            ) : null}
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
      </KeyboardFormScrollView>
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

function Identity({ label, value }: { label: string; value: string }) {
  const { c, font } = useTheme()
  return (
    <View style={styles.identity}>
      <Text style={{ color: c.ink3, fontFamily: font.ui, fontSize: font.size.body }}>{label}</Text>
      <Text
        selectable
        style={{
          color: c.ink,
          fontFamily: font.ui,
          fontSize: font.size.body,
          flexShrink: 1,
          textAlign: 'right',
        }}
      >
        {value}
      </Text>
    </View>
  )
}
const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 40, gap: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: { padding: 14, gap: 12, borderWidth: 1 },
  identity: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
})
