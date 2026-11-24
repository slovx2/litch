// 在一台设备上添加飞书应用：创建向导（填机器人名 → 在系统浏览器打开飞书创建页 → 设备自动检测完成）。
// 手机上不填 App Secret（手动填写已有应用只在桌面）。离开这一页时仍在等待的创建一并取消。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useEffect, useRef, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { clockText, operationId } from '../../../../../../packages/ui/src/external/model.ts'
import { feishuFailure } from '../../../../../../packages/ui/src/feishu/failure.ts'
import {
  botNameProblem,
  FEISHU_BOT_NAME_MAX,
  type FeishuRegistration,
  registrationEnd,
  secondsLeft,
} from '../../../../../../packages/ui/src/feishu/model.ts'
import type { RootStackParamList } from '../../../nav/routes'
import { useChannel } from '../../../shell/services'
import { useT } from '../../../ui/i18n'
import { Button, Field } from '../../../ui/kit/controls'
import { KeyboardFormScrollView } from '../../../ui/kit/KeyboardForm'
import { Screen } from '../../../ui/kit/Screen'
import { useTheme } from '../../../ui/theme'
import { useNow } from '../../sessions/clock'
import { useFeishuRegistration } from './use-feishu'

type Props = NativeStackScreenProps<RootStackParamList, 'FeishuAdd'>

export function FeishuAddScreen({ route, navigation }: Props) {
  const { deviceId } = route.params
  const t = useT()
  const { c, font } = useTheme()
  const channel = useChannel()
  const now = useNow()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [registrationId, setRegistrationId] = useState<string | null>(null)
  const [first, setFirst] = useState<FeishuRegistration | null>(null)
  const snapshot = useFeishuRegistration(deviceId, registrationId)
  const registration = snapshot?.value ?? first
  const waiting = registration?.state === 'waiting'
  const problem = botNameProblem(name)

  // 离开这一页时取消还在等的创建：记住最新的那一次
  const pending = useRef<string | null>(null)
  pending.current = waiting && registration ? registration.registrationId : null
  useEffect(
    () => () => {
      const id = pending.current
      if (id)
        void channel
          .command('feishu.app.register.cancel', { deviceId, registrationId: id })
          .catch(() => {})
    },
    [channel, deviceId],
  )

  const open = (url: string | undefined) => {
    if (url) void Linking.openURL(url).catch(() => {})
  }
  const begin = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await channel.command('feishu.app.register.begin', {
        deviceId,
        operationId: operationId(),
        name: name.trim(),
      })
      setFirst(result.registration)
      setRegistrationId(result.registration.registrationId)
      open(result.registration.url)
    } catch (failed) {
      setError(feishuFailure(failed, t))
    } finally {
      setBusy(false)
    }
  }
  const cancel = () => {
    if (!registration) return
    void channel
      .command('feishu.app.register.cancel', {
        deviceId,
        registrationId: registration.registrationId,
      })
      .catch((failed: unknown) => setError(feishuFailure(failed, t)))
  }
  const restart = () => {
    setRegistrationId(null)
    setFirst(null)
    setError('')
  }

  const note = [styles.note, { color: c.ink3, fontSize: font.size.meta }]
  return (
    <Screen title={t('feishu.add')} testID="feishu-add">
      <KeyboardFormScrollView>
        {!registration ? (
          <>
            <Field
              label={t('feishu.add.name')}
              value={name}
              onChangeText={setName}
              testID="feishu:name"
              {...(problem === 'long'
                ? { error: t('feishu.add.nameLong', { max: FEISHU_BOT_NAME_MAX }) }
                : {})}
            />
            <Text style={note}>{t('feishu.exclusive')}</Text>
            <Text style={note}>{t('mfs.manualDesktop')}</Text>
            <View style={styles.buttons}>
              <Button
                label={t('feishu.add.start')}
                testID="feishu:begin"
                busy={busy}
                disabled={problem !== null}
                onPress={() => void begin()}
              />
            </View>
          </>
        ) : waiting ? (
          <View testID="feishu:waiting">
            <Text style={[styles.body, { color: c.ink }]}>{t('feishu.add.waiting')}</Text>
            <Text style={note}>
              {t('feishu.add.left', { time: clockText(secondsLeft(registration.expiresAt, now)) })}
            </Text>
            <View style={styles.buttons}>
              <Button
                kind="plain"
                label={t('feishu.add.reopen')}
                testID="feishu:reopen"
                onPress={() => open(registration.url)}
              />
              <Button
                kind="quiet"
                label={t('feishu.cancel')}
                testID="feishu:cancel"
                onPress={cancel}
              />
            </View>
          </View>
        ) : (
          <View testID={`feishu:end:${registration.state}`}>
            <Text
              style={[styles.body, { color: registration.state === 'succeeded' ? c.ink : c.err }]}
            >
              {t(`feishu.add.end.${registrationEnd(registration)}`)}
            </Text>
            <View style={styles.buttons}>
              {registration.state === 'succeeded' && registration.appId ? (
                <Button
                  label={t('feishu.add.view')}
                  testID="feishu:view"
                  onPress={() =>
                    navigation.replace('FeishuApp', {
                      deviceId,
                      appId: registration.appId ?? '',
                      title: registration.name,
                    })
                  }
                />
              ) : (
                <Button
                  kind="plain"
                  label={t('feishu.add.retry')}
                  testID="feishu:retry"
                  onPress={restart}
                />
              )}
            </View>
          </View>
        )}
        {error ? <Text style={[styles.note, { color: c.err }]}>{error}</Text> : null}
      </KeyboardFormScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 22, paddingHorizontal: 16, paddingTop: 12 },
  note: { lineHeight: 18, paddingHorizontal: 16, paddingVertical: 4 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 16 },
})
