// 提案卡点“开始”时模型越级的提示（手机）：一句原因，就地改用一个允许的模型开始，
// 再给“调整模型等级”跳到设备详情的排序。经理的设置在桌面，手机不给“改经理默认模型”。
// 取哪些模型、文案键与桌面同一份（packages/ui/src/tree/model-limit.ts）。
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import {
  allowedChoices,
  defaultChoice,
  LIMIT_TARGET_TEXT,
  type ModelLimitFailureView,
} from '../../../../../packages/ui/src/tree/model-limit.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { Button, Chip } from '../../ui/kit/controls'
import { useTheme } from '../../ui/theme'

export function ModelLimitNotice({
  limit,
  busy,
  onUseModel,
  testID,
}: {
  limit: ModelLimitFailureView
  busy: boolean
  onUseModel(choice: { harness: string; model: string }): void
  testID?: string
}) {
  const t = useT()
  const { c, font, radius } = useTheme()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const choices = allowedChoices(limit)
  const [picked, setPicked] = useState(() => defaultChoice(limit, choices))
  const choice = choices.find((entry) => entry.model === picked)
  const targets = limit.settings.filter((target) => target.kind === 'model-ranking')
  return (
    <View
      accessibilityRole="alert"
      testID={testID}
      style={[styles.box, { borderColor: c.wait, borderRadius: radius.m }]}
    >
      <Text style={{ color: c.ink, fontSize: font.size.meta, lineHeight: 19 }}>
        {t.text(limit.text)}
      </Text>
      {choices.length > 0 ? (
        <>
          <Text style={{ color: c.ink3, fontSize: font.size.small }}>{t('limit.pick')}</Text>
          <View style={styles.chips}>
            {choices.map((entry) => (
              <Chip
                key={`${entry.harness}:${entry.model}`}
                label={entry.name}
                radio
                on={entry.model === picked}
                disabled={busy}
                onPress={() => setPicked(entry.model)}
              />
            ))}
          </View>
          <Button
            label={t('limit.start')}
            disabled={busy || !choice}
            onPress={() => choice && onUseModel(choice)}
            testID="limit:use"
          />
        </>
      ) : (
        <Text style={{ color: c.ink3, fontSize: font.size.meta }}>{t('limit.none')}</Text>
      )}
      {targets.map((target) => (
        <Button
          key={target.kind}
          kind="plain"
          label={t(LIMIT_TARGET_TEXT[target.kind])}
          onPress={() =>
            navigation.navigate('DeviceDetail', { deviceId: target.deviceId, section: 'ranking' })
          }
          testID={`limit:${target.kind}`}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { borderWidth: 1, padding: 12, gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
})
