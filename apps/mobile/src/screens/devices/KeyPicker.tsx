// 选一把钥匙：列出这台手机上有的（点一下选中），生成一把新的，或者导入一把已有的私钥
// （粘贴或者从文件选，可以带口令）。选中的那一把下面摆出公钥和授权的那一句，好复制去那台机器上。
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { generateKey, importKey, type KeyInfo } from '../../platform/keys'
import { sshProblem } from '../../platform/ssh-errors'
import { useBusy } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Button, Field, Row } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'
import { PublicKeyCard } from './parts'

/** 指纹太长，行上只放头尾 */
const shortPrint = (fingerprint: string) =>
  fingerprint.length > 28 ? `${fingerprint.slice(0, 18)}…${fingerprint.slice(-6)}` : fingerprint

export function KeyPicker({
  keys,
  selected,
  onSelect,
  onAdded,
}: {
  keys: KeyInfo[]
  selected: string | null
  onSelect(id: string): void
  onAdded(key: KeyInfo): void
}) {
  const t = useT()
  const theme = useTheme()
  const [importing, setImporting] = useState(false)
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [generating, runGenerate] = useBusy()
  const [reading, runImport] = useBusy()

  const failed = (problem: unknown) => {
    const { kind, message } = sshProblem(problem)
    setError(
      kind === 'keyLocked'
        ? t('devices.key.locked')
        : kind === 'key'
          ? t('devices.key.invalid')
          : t('devices.key.failed', { reason: message }),
    )
  }

  const generate = async () => {
    setError(null)
    try {
      onAdded(await runGenerate(generateKey()))
    } catch (problem) {
      failed(problem)
    }
  }

  const pick = async () => {
    setError(null)
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
    const asset = picked.canceled ? null : picked.assets[0]
    if (!asset) return
    try {
      const file = new File(asset.uri)
      setPrivateKey(file.textSync())
      file.delete()
    } catch (problem) {
      failed(problem)
    }
  }

  const doImport = async () => {
    setError(null)
    try {
      const key = await runImport(importKey(privateKey, passphrase))
      setPrivateKey('')
      setPassphrase('')
      setImporting(false)
      onAdded(key)
    } catch (problem) {
      failed(problem)
    }
  }

  const chosen = keys.find((key) => key.id === selected) ?? null
  return (
    <View>
      {keys.length === 0 ? (
        <Text style={[styles.note, styles.pad, { color: theme.c.ink2 }]}>
          {t('devices.key.none')}
        </Text>
      ) : (
        keys.map((key) => (
          <Row
            key={key.id}
            testID={`key:${key.id}`}
            title={shortPrint(key.fingerprint)}
            detail={`${key.publicKey.split(' ')[0]} · ${t(key.origin === 'generated' ? 'devices.key.generated' : 'devices.key.imported')}`}
            selected={key.id === selected}
            onPress={() => onSelect(key.id)}
          />
        ))
      )}
      <View style={[styles.pad, styles.buttons]}>
        <Button
          kind="plain"
          label={t('devices.key.generate')}
          busy={generating}
          testID="key:generate"
          onPress={() => void generate()}
        />
        <Button
          kind="plain"
          label={t('devices.key.import')}
          testID="key:import"
          onPress={() => setImporting(!importing)}
        />
      </View>
      {importing ? (
        <View style={[styles.pad, styles.form]}>
          <Field
            label={t('devices.key.paste')}
            hint={t('devices.key.paste.hint')}
            value={privateKey}
            onChangeText={setPrivateKey}
            multiline
            testID="key:paste"
            style={{ fontFamily: theme.font.mono, fontSize: 11 }}
          />
          <Button kind="plain" label={t('devices.key.pickFile')} onPress={() => void pick()} />
          <Field
            label={t('devices.key.passphrase')}
            hint={t('devices.key.passphrase.hint')}
            value={passphrase}
            onChangeText={setPassphrase}
            secureTextEntry
            testID="key:passphrase"
          />
          <Button
            label={t('devices.key.doImport')}
            disabled={!privateKey.trim()}
            busy={reading}
            testID="key:doImport"
            onPress={() => void doImport()}
          />
        </View>
      ) : null}
      {error ? (
        <Text style={[styles.note, styles.pad, { color: theme.c.err }]} testID="key:error">
          {error}
        </Text>
      ) : null}
      {chosen ? (
        <View style={styles.pad}>
          <Text style={[styles.label, { color: theme.c.ink3 }]}>{t('devices.key.public')}</Text>
          <PublicKeyCard publicKey={chosen.publicKey} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16, paddingVertical: 10 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  form: { gap: 12 },
  note: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 12, marginBottom: 6 },
})
