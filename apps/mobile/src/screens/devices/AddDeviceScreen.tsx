// 加设备：填主机、端口、用户 → 选一把钥匙（生成新的，或者导入已有的私钥；公钥可以复制去那台机器上授权）
// → “连上去看看”：先读主机钥匙的指纹、没信任过就问一声，再经核心看一眼对面有什么（remote.check，不启动任何东西）
// → 添加。添加之后核心就开始连，页面换成这台设备的会话。
import type { RemoteCheck, RemoteTarget } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller'
import type { RootStackParamList } from '../../nav/routes'
import { type KeyInfo, listKeys } from '../../platform/keys'
import { useBusy, useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field, SectionLabel } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { KeyPicker } from './KeyPicker'
import { FailureCard, useHostTrust } from './parts'

type Props = NativeStackScreenProps<RootStackParamList, 'AddDevice'>

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 检查的结果说成一两句话 */
function CheckResult({ result }: { result: Extract<RemoteCheck, { ok: true }> }) {
  const theme = useTheme()
  const t = useT()
  const lines: string[] = []
  if (result.peer === 'codex') {
    lines.push(t('devices.check.codex', { version: result.version }), t('devices.check.codexOnly'))
  } else {
    lines.push(t('devices.check.service', { version: result.version }))
    if (!result.running) lines.push(t('devices.check.idle'))
    else if (result.harnesses) {
      const ready = result.harnesses.filter((harness) => harness.state === 'ready')
      lines.push(
        ready.length > 0
          ? t('devices.check.harnesses', { names: ready.map((harness) => harness.name).join('、') })
          : t('devices.check.noHarness'),
      )
    }
  }
  return (
    <View
      style={[styles.result, { borderColor: theme.c.ok, backgroundColor: theme.c.raised }]}
      testID={`check:${result.peer}`}
    >
      {lines.map((line) => (
        <Text key={line} style={[styles.note, { color: theme.c.ink }]}>
          {line}
        </Text>
      ))}
    </View>
  )
}

export function AddDeviceScreen({ navigation }: Props) {
  const t = useT()
  const theme = useTheme()
  const channel = useChannel()
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [name, setName] = useState('')
  const [keys, setKeys] = useState<KeyInfo[]>(() => listKeys())
  const [keyId, setKeyId] = useState<string | null>(() => {
    const all = listKeys()
    return all[all.length - 1]?.id ?? null
  })
  const [result, setResult] = useState<RemoteCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, runCheck] = useBusy()
  const [adding, runAdd] = useBusy()
  const trust = useHostTrust()

  const portNumber = Number(port.trim() || '22')
  const target = (): RemoteTarget | null => {
    if (!host.trim() || !user.trim() || !keyId) return null
    return {
      kind: 'host',
      host: host.trim(),
      port: portNumber === 22 ? null : portNumber,
      user: user.trim(),
      keyFile: keyId,
    }
  }
  // 改了怎么连，上一次的检查就不算数了
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    setResult(null)
  }

  const check = async () => {
    setError(null)
    setResult(null)
    const wanted = target()
    if (wanted?.kind !== 'host') {
      setError(t('devices.field.missing'))
      return
    }
    try {
      const trusted = await trust.confirm(wanted.host, portNumber, wanted.user ?? '')
      if (!trusted) return
      setResult(await runCheck(channel.command('remote.check', { target: wanted })))
    } catch (failed) {
      setError(reasonOf(failed))
    }
  }

  const add = async () => {
    const wanted = target()
    if (!wanted) return
    try {
      const { deviceId } = await runAdd(
        channel.command('device.add', { name: name.trim(), target: wanted }),
      )
      navigation.replace('Sessions', { deviceId })
    } catch (failed) {
      setError(t('devices.failed', { reason: reasonOf(failed) }))
    }
  }

  const publicKey = keys.find((key) => key.id === keyId)?.publicKey ?? null
  return (
    <Screen title={t('add.title')} testID="add-device">
      <KeyboardAwareScrollView keyboardShouldPersistTaps="handled" bottomOffset={24}>
        <SectionLabel>{t('devices.where')}</SectionLabel>
        <View style={styles.form}>
          <Field
            label={t('devices.field.host')}
            hint={t('devices.field.host.hint')}
            value={host}
            onChangeText={edit(setHost)}
            keyboardType="url"
            testID="add:host"
          />
          <View style={styles.pair}>
            <View style={styles.port}>
              <Field
                label={t('devices.field.port')}
                value={port}
                onChangeText={edit(setPort)}
                keyboardType="number-pad"
                testID="add:port"
              />
            </View>
            <View style={styles.user}>
              <Field
                label={t('devices.field.user')}
                value={user}
                onChangeText={edit(setUser)}
                testID="add:user"
              />
            </View>
          </View>
          <Field
            label={t('devices.field.name')}
            hint={t('devices.field.name.hint')}
            value={name}
            onChangeText={setName}
            testID="add:name"
          />
        </View>
        <SectionLabel>{t('devices.key')}</SectionLabel>
        <KeyPicker
          keys={keys}
          selected={keyId}
          onSelect={(id) => {
            setKeyId(id)
            setResult(null)
          }}
          onAdded={(key) => {
            setKeys(listKeys())
            setKeyId(key.id)
            setResult(null)
          }}
        />
        <SectionLabel>{t('devices.check')}</SectionLabel>
        <View style={styles.form}>
          <Text style={[styles.note, { color: theme.c.ink3 }]}>{t('devices.check.hint')}</Text>
          <Button
            kind={result?.ok ? 'plain' : 'solid'}
            label={t('devices.check')}
            busy={checking}
            testID="add:check"
            onPress={() => void check()}
          />
          {trust.notice ? (
            <Text style={[styles.note, { color: theme.c.ink2 }]}>{trust.notice}</Text>
          ) : null}
          {trust.error || error ? (
            <Text style={[styles.note, { color: theme.c.err }]} testID="add:error">
              {trust.error ?? error}
            </Text>
          ) : null}
        </View>
        {result?.ok ? <CheckResult result={result} /> : null}
        {result && !result.ok ? (
          <FailureCard failure={result.failure} target={target()} publicKey={publicKey} />
        ) : null}
        <View style={styles.form}>
          <Button
            label={t('devices.submit')}
            disabled={!result?.ok}
            busy={adding}
            testID="add:submit"
            onPress={() => void add()}
          />
        </View>
      </KeyboardAwareScrollView>
      {trust.dialog}
    </Screen>
  )
}

const styles = StyleSheet.create({
  form: { padding: 16, gap: 14 },
  pair: { flexDirection: 'row', gap: 12 },
  port: { width: 96 },
  user: { flex: 1 },
  note: { fontSize: 14, lineHeight: 20 },
  result: { marginHorizontal: 16, padding: 12, borderWidth: 1, gap: 6 },
})
