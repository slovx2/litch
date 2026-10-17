// 首页：设备列表。主线搭的最小版本（能列出设备、点进会话列表），连接线接手后补全：
// 连接状态与失败原因、忙闲和待处理数（keys.activity、keys.tallies）、加设备入口、长按菜单。
import { type DeviceView, keys } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { FlatList } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, Row } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'Devices'>

function DeviceRow({ deviceId, onPress }: { deviceId: string; onPress(device: DeviceView): void }) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const t = useT()
  if (!device) return null
  return (
    <Row
      testID={`device:${deviceId}`}
      title={t.text(device.name)}
      detail={device.host}
      meta={device.connection}
      onPress={() => onPress(device)}
    />
  )
}

export function DevicesScreen({ navigation }: Props) {
  const t = useT()
  const ids = useKey<string[]>(keys.devices) ?? []
  return (
    <Screen
      title="Litch"
      back={false}
      actions={[
        { label: '⚙', testID: 'devices:settings', onPress: () => navigation.navigate('Settings') },
      ]}
      testID="devices"
    >
      <FlatList
        data={ids}
        keyExtractor={(id) => id}
        renderItem={({ item }) => (
          <DeviceRow
            deviceId={item}
            onPress={(device) => navigation.navigate('Sessions', { deviceId: device.id })}
          />
        )}
        ListEmptyComponent={<Empty title={t('app.todo')} />}
      />
    </Screen>
  )
}
