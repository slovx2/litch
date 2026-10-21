// 提案卡右上角的“⋯”：底部动作单里一项“在 {设备} 上对 {harness} 关闭任务卡”，点了直接关，
// 卡片下面出一行“已对 X 关闭任务卡 · 撤销 · 去设置”，过一会儿自己收起；卡片本身留着，还能开始。
// 写设备设置用桌面那一份（packages/ui/src/tree/task-cards-write.ts）。harness 是这个会话的，不是提案要开在哪的。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { nameOf } from '../../../../../packages/ui/src/app/device.ts'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import {
  TaskCardsMissing,
  writeTaskCards,
} from '../../../../../packages/ui/src/tree/task-cards-write.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey, useServices } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Sheet } from '../../ui/kit/overlays'
import { useTheme } from '../../ui/theme'

/** 关掉之后那一行留多久 */
const NOTICE_MS = 9000

type Notice = { kind: 'off' } | { kind: 'failed'; text: string } | null

/** 卡片标题行上的“⋯”和它的动作单；关掉之后的那一行（notice）由卡片排在下面 */
export function useCardsOff(deviceId: string, sessionId: string, proposalId: string) {
  const { c, font } = useTheme()
  const t = useT()
  const { channel, replica } = useServices()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const harness = useKey<SessionSummary>(keys.summary(deviceId, sessionId))?.harness ?? null
  const [sheet, setSheet] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  if (!device || !harness) return { button: null, sheet: null, notice: null }
  const name = nameOf(device, harness)
  // 开关存在设备上：设备要连着、有设置接口
  const usable = !busy && device.connection === 'online' && device.manageable
  const write = (on: boolean) => {
    setBusy(true)
    writeTaskCards(channel, replica, deviceId, harness, on)
      .then(() => setNotice(on ? null : { kind: 'off' }))
      .catch((error: unknown) =>
        setNotice({
          kind: 'failed',
          text:
            error instanceof TaskCardsMissing
              ? t('proposal.cardsOff.missing')
              : t('proposal.cardsOff.failed', { reason: whyNot(error, t) }),
        }),
      )
      .finally(() => setBusy(false))
  }
  const link = (label: string, onPress: () => void, testID: string) => (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8} testID={testID}>
      <Text style={{ color: c.accent, fontSize: font.size.meta }}>{label}</Text>
    </Pressable>
  )
  return {
    button: (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('proposal.more')}
        hitSlop={{ top: 10, bottom: 10, left: 14, right: 14 }}
        onPress={() => setSheet(true)}
        style={({ pressed }) => [styles.more, pressed ? { backgroundColor: c.press } : null]}
        testID={`proposal:${proposalId}:more`}
      >
        <Text style={{ color: c.ink3, fontFamily: font.mono }}>⋯</Text>
      </Pressable>
    ),
    sheet: (
      <Sheet
        visible={sheet}
        onClose={() => setSheet(false)}
        actions={
          usable
            ? [
                {
                  label: t('proposal.cardsOff', { device: t.text(device.name), harness: name }),
                  onPress: () => write(false),
                  testID: `proposal:${proposalId}:cards-off`,
                },
              ]
            : []
        }
      />
    ),
    notice: notice ? (
      <View style={styles.notice} testID={`proposal:${proposalId}:cards-off-notice`}>
        {notice.kind === 'failed' ? (
          <Text style={{ color: c.err, fontSize: font.size.meta }}>{notice.text}</Text>
        ) : (
          <>
            <Text style={{ color: c.ink2, fontSize: font.size.meta }}>
              {t('proposal.cardsOff.done', { harness: name })}
            </Text>
            {link(t('proposal.cardsOff.undo'), () => write(true), `proposal:${proposalId}:undo`)}
            {link(
              t('proposal.cardsOff.settings'),
              () => {
                setNotice(null)
                navigation.navigate('Settings')
              },
              `proposal:${proposalId}:settings`,
            )}
          </>
        )}
      </View>
    ) : null,
  }
}

const styles = StyleSheet.create({
  more: { paddingHorizontal: 6 },
  notice: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 },
})
