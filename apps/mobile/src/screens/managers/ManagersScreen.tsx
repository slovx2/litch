// 手机经理目录：进行中的经理按设备分组；已结束的经理合成一组，默认收起。
import { type DeviceView, keys, type ManagerView, type SessionSummary } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { reasonOf } from '../../../../../packages/ui/src/app/errors.ts'
import { ago } from '../../../../../packages/ui/src/app/format.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, ErrorBanner, Row, SectionLabel, sectionFont } from '../../ui/kit/controls'
import { Fold } from '../../ui/kit/Icon'
import { StatusMark } from '../../ui/kit/marks'
import { Sheet } from '../../ui/kit/overlays'
import { Screen } from '../../ui/kit/Screen'
import { plainLine } from '../../ui/plain-text'
import { useTheme } from '../../ui/theme'
import { useReadMenu } from '../sessions/read-menu'
import { managerRowState } from './presentation'

type Props = NativeStackScreenProps<RootStackParamList, 'Managers'>
function ManagerRow({
  manager,
  navigation,
}: {
  manager: ManagerView
  navigation: Props['navigation']
}) {
  const t = useT()
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const readActions = useReadMenu(manager.deviceId, manager.threadId, (work) => {
    setError(null)
    void work.catch((cause) => setError(reasonOf(cause, t)))
  })
  const summary = useKey<SessionSummary>(keys.summary(manager.deviceId, manager.threadId))
  const { c, radius, font } = useTheme()
  const { mark, pending, text } = managerRowState(manager, summary)
  const { key, ...args } = text
  const state = t(key, args)
  const latest = plainLine(manager.latestActivity?.text ?? manager.scope)
  const title = manager.name || t('manager.manager')
  const detail = [state, latest].filter(Boolean).join(' · ')
  const meta = manager.latestActivity ? ago(manager.latestActivity.at, Date.now(), t) : undefined
  return (
    <>
      {error ? <ErrorBanner text={error} onClose={() => setError(null)} /> : null}
      <Row
        title={title}
        detail={detail}
        meta={meta}
        // 胶囊只是一个数字，读屏要在整行名称里念出“N 待处理”
        label={[title, pending > 0 ? t('manager.pending', { n: pending }) : '', detail, meta]
          .filter(Boolean)
          .join(' · ')}
        left={<StatusMark status={mark} />}
        trail="forward"
        right={
          pending > 0 ? (
            <Text
              testID={`manager:${manager.id}:pending`}
              aria-label={t('manager.pending', { n: pending })}
              style={[
                styles.pill,
                {
                  color: c.wait,
                  borderColor: c.wait,
                  borderRadius: radius.l,
                  fontFamily: font.mono,
                },
              ]}
            >
              {pending}
            </Text>
          ) : undefined
        }
        testID={`manager:${manager.id}`}
        onLongPress={readActions.length ? () => setMenu(true) : undefined}
        onPress={() =>
          navigation.navigate('ManagerConsole', {
            deviceId: manager.deviceId,
            managerId: manager.id,
          })
        }
      />
      <Sheet visible={menu} title={title} actions={readActions} onClose={() => setMenu(false)} />
    </>
  )
}
function ManagerKey({
  deviceId,
  id,
  navigation,
}: {
  deviceId: string
  id: string
  navigation: Props['navigation']
}) {
  const manager = useKey<ManagerView>(keys.manager(deviceId, id))
  if (!manager) return null
  return <ManagerRow manager={manager} navigation={navigation} />
}
function DeviceManagers({
  deviceId,
  ended,
  navigation,
}: {
  deviceId: string
  ended: boolean
  navigation: Props['navigation']
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const all = useKey<string[]>(keys.managerIds(deviceId)) ?? []
  const endedIds = useKey<string[]>(keys.managerEndedIds(deviceId)) ?? []
  const ids = ended ? endedIds : all.filter((id) => !endedIds.includes(id))
  if (!ids.length) return null
  return (
    <View testID={`managers:${ended ? 'ended-device' : 'device'}:${deviceId}`}>
      <SectionLabel>{device ? t.text(device.name) : deviceId}</SectionLabel>
      {ids.map((id) => (
        <ManagerKey key={id} deviceId={deviceId} id={id} navigation={navigation} />
      ))}
    </View>
  )
}
export function ManagersScreen({ navigation }: Props) {
  const devices = useKey<string[]>(keys.devices) ?? []
  const summary = useKey<{ total: number; ended: number }>(keys.managersSummary)
  const [showEnded, setShowEnded] = useState(false)
  const t = useT()
  const theme = useTheme()
  const { c, font } = theme
  return (
    <Screen title={t('manager.title')} testID="managers">
      <ScrollView>
        {devices.map((deviceId) => (
          <DeviceManagers
            key={deviceId}
            deviceId={deviceId}
            ended={false}
            navigation={navigation}
          />
        ))}
        {summary && summary.ended > 0 ? (
          <>
            {/* 折叠头与设备分组标题同一套字号、颜色和左右边距，计数跟在名字后面，不另占右侧 */}
            <Fold
              open={showEnded}
              onToggle={() => setShowEnded((value) => !value)}
              testID="managers:ended"
              label={`${t('manager.ended')} · ${summary.ended}`}
              style={styles.ended}
            >
              <View style={styles.endedHead}>
                <Text style={[styles.endedText, sectionFont(theme), { color: c.ink2 }]}>
                  {t('manager.ended')}
                </Text>
                <Text
                  testID="managers:ended-count"
                  style={[styles.endedText, { color: c.ink3, fontFamily: font.mono }]}
                >
                  {summary.ended}
                </Text>
              </View>
            </Fold>
            {showEnded
              ? devices.map((deviceId) => (
                  <DeviceManagers
                    key={deviceId}
                    deviceId={deviceId}
                    ended
                    navigation={navigation}
                  />
                ))
              : null}
          </>
        ) : null}
        {summary && summary.total === 0 ? (
          <Empty title={t('manager.empty')} detail={t('mgr.empty.detail')} />
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  ended: { paddingHorizontal: 16, paddingTop: 8 },
  endedHead: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  endedText: { fontSize: 12 },
  pill: {
    borderWidth: 1,
    minWidth: 24,
    paddingHorizontal: 7,
    paddingVertical: 1,
    marginRight: 12,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
  },
})
