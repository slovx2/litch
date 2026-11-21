import type { ExternalManagerRecovery } from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../../nav/routes'
import { useT } from '../../../ui/i18n'
import { Button } from '../../../ui/kit/controls'

/** 从收件详情或设备页转到经理，沿用经理的能力刷新与接班确认。 */
export function ManagerRecovery({
  deviceId,
  recovery,
  disabled,
  onOpen,
}: {
  deviceId: string
  recovery: ExternalManagerRecovery
  disabled: boolean
  onOpen?: () => void
}) {
  const t = useT()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  return (
    <Button
      kind="plain"
      label={t('mgh.openManagerRecovery')}
      disabled={disabled}
      onPress={() => {
        onOpen?.()
        navigation.navigate('ManagerConsole', {
          deviceId,
          managerId: recovery.managerId,
          tab: 'console',
        })
      }}
    />
  )
}
