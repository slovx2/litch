// 手机经理目录：按设备分组，每组先进行中、后已结束；新建、设置和调度仍在桌面。
import { type DeviceView, keys, type ManagerView, managerAttentionCount } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { ScrollView, View } from 'react-native'
import { ago } from '../../../../../packages/ui/src/app/format.ts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, Row, SectionLabel, StatusMark } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { plainLine } from './presentation'

type Props = NativeStackScreenProps<RootStackParamList, 'Managers'>
function ManagerRow({
  manager,
  navigation,
}: {
  manager: ManagerView
  navigation: Props['navigation']
}) {
  const t = useT()
  const count = manager.status === 'active' ? managerAttentionCount(manager) : 0
  const state =
    manager.status !== 'active'
      ? t(`manager.${manager.status}`)
      : count > 0
        ? t('manager.pending', { n: count })
        : manager.runningLines > 0
          ? t('mgr.row.lines', { count: manager.runningLines })
          : ''
  const latest = plainLine(manager.latestActivity?.text ?? manager.scope)
  return (
    <Row
      title={manager.name || t('manager.manager')}
      detail={[state, latest].filter(Boolean).join(' · ')}
      meta={manager.latestActivity ? ago(manager.latestActivity.at, Date.now(), t) : undefined}
      left={
        <StatusMark
          status={
            manager.status !== 'active'
              ? 'offline'
              : count > 0
                ? 'waiting'
                : manager.runningLines > 0
                  ? 'running'
                  : 'idle'
          }
        />
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
