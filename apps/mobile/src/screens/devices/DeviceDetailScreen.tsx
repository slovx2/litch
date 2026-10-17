// 设备详情：主线只放了占位，连接线接手。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'DeviceDetail'>

export function DeviceDetailScreen(_props: Props) {
  const t = useT()
  return (
    <Screen title="设备详情" testID="device-detail">
      <Empty title={t('app.todo')} />
    </Screen>
  )
}
