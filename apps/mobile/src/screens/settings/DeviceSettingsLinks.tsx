import { type DeviceView, keys } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Row, SectionLabel } from '../../ui/kit/controls'
import { shownState } from '../devices/failure'

function DeviceLink({ deviceId }: { deviceId: string }) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const t = useT()
  if (!device) return null
  return (
    <Row
      title={t.text(device.name)}
      meta={t(`devices.state.${shownState(device)}`)}
      testID={`settings:device:${deviceId}`}
      onPress={() => navigation.navigate('DeviceDetail', { deviceId })}
    />
  )
}

/** 设置首页直接列出所有设备；无需先回到首页打开设备菜单。 */
export function DeviceSettingsLinks() {
  const ids = useKey<string[]>(keys.devices) ?? []
  const t = useT()
  return (
    <>
      <SectionLabel>{t('sidebar.devices')}</SectionLabel>
      {ids.map((id) => (
        <DeviceLink key={id} deviceId={id} />
      ))}
    </>
  )
}
