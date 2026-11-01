// 手机经理目录：按设备分组，每组先进行中、后已结束；新建、设置和调度仍在桌面。
import { type DeviceView, keys, type ManagerView, type SessionSummary } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { ago } from '../../../../../packages/ui/src/app/format.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, Row, SectionLabel, StatusMark } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'
import { managerRowState, plainLine } from './presentation'

type Props = NativeStackScreenProps<RootStackParamList, 'Managers'>
function ManagerRow({
  manager,
  navigation,
}: {
  manager: ManagerView
  navigation: Props['navigation']
}) {
  const t = useT()
  const summary = useKey<SessionSummary>(keys.summary(manager.deviceId, manager.threadId))
  const { c, radius, font } = useTheme()
  const { mark, pending, text } = managerRowState(manager, summary)
  const { key, ...args } = text
  const state = t(key, args)
  const latest = plainLine(manager.latestActivity?.text ?? manager.scope)
  return (
    <Row
      title={manager.name || t('manager.manager')}
      detail={[state, latest].filter(Boolean).join(' · ')}
      meta={manager.latestActivity ? ago(manager.latestActivity.at, Date.now(), t) : undefined}
      left={<StatusMark status={mark} />}
      right={
        pending > 0 ? (
          <Text
            testID={`manager:${manager.id}:pending`}
            aria-label={t('manager.pending', { n: pending })}
            style={[
              styles.pill,
              { color: c.wait, borderColor: c.wait, borderRadius: radius.l, fontFamily: font.mono },
            ]}
          >
            {pending}
          </Text>
        ) : undefined
      }
      testID={`manager:${manager.id}`}
      onPress={() =>
        navigation.navigate('ManagerConsole', { deviceId: manager.deviceId, managerId: manager.id })
      }
    />
  )
}
function ManagerKey({
  deviceId,
  id,
  status,
  navigation,
}: {
  deviceId: string
  id: string
  status: 'active' | 'ended'
  navigation: Props['navigation']
}) {
  const manager = useKey<ManagerView>(keys.manager(deviceId, id))
  if (!manager || (status === 'active') !== (manager.status !== 'ended')) return null
  return <ManagerRow manager={manager} navigation={navigation} />
}
function DeviceManagers({
  deviceId,
  navigation,
}: {
  deviceId: string
  navigation: Props['navigation']
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const ids = useKey<string[]>(keys.managerIds(deviceId)) ?? []
  if (!ids.length) return null
  return (
    <View testID={`managers:device:${deviceId}`}>
      <SectionLabel>{device ? t.text(device.name) : deviceId}</SectionLabel>
      {(['active', 'ended'] as const).map((status) =>
        ids.map((id) => (
          <ManagerKey
            key={`${status}:${id}`}
            deviceId={deviceId}
            id={id}
            status={status}
            navigation={navigation}
          />
        )),
      )}
    </View>
  )
}
export function ManagersScreen({ navigation }: Props) {
  const devices = useKey<string[]>(keys.devices) ?? []
  const summary = useKey<{ total: number }>(keys.managersSummary)
  const t = useT()
  return (
    <Screen title={t('manager.title')} testID="managers">
      <ScrollView>
        {devices.map((deviceId) => (
          <DeviceManagers key={deviceId} deviceId={deviceId} navigation={navigation} />
        ))}
        {summary && summary.total === 0 ? (
          <Empty title={t('manager.empty')} detail={t('mgr.empty.detail')} />
        ) : null}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
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
