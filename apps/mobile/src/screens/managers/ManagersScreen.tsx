// 手机经理入口只读目录；设置和调度仍在桌面。
import { keys, type ManagerView } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { ScrollView, View } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Row } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'Managers'>
function ManagerRow({
  deviceId,
  id,
  navigation,
}: {
  deviceId: string
  id: string
  navigation: Props['navigation']
}) {
  const manager = useKey<ManagerView>(keys.manager(deviceId, id))
  const t = useT()
  if (!manager) return null
  const count =
    manager.pendingDecisions +
    (manager.pendingRequests ?? 0) +
    (manager.pendingReports ?? 0) +
    (manager.pendingSuggestions ?? 0)
  return (
    <Row
      title={manager.name || t('manager.manager')}
      detail={t('manager.pending', { n: count })}
      testID={`manager:${id}`}
      onPress={() => navigation.navigate('ManagerConsole', { deviceId, managerId: id })}
    />
  )
}
function DeviceManagers({
  deviceId,
  navigation,
}: {
  deviceId: string
  navigation: Props['navigation']
}) {
  const ids = useKey<string[]>(keys.managerIds(deviceId)) ?? []
  return (
    <View>
      {ids.map((id) => (
        <ManagerRow key={id} deviceId={deviceId} id={id} navigation={navigation} />
      ))}
    </View>
  )
}
export function ManagersScreen({ navigation }: Props) {
  const devices = useKey<string[]>(keys.devices) ?? []
  const t = useT()
  return (
    <Screen title={t('manager.inbox')} testID="managers">
      <ScrollView>
        {devices.map((deviceId) => (
          <DeviceManagers key={deviceId} deviceId={deviceId} navigation={navigation} />
        ))}
      </ScrollView>
    </Screen>
  )
}
