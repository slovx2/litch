// 终端：主线只放了占位，工具页线接手。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'Terminal'>

export function TerminalScreen(_props: Props) {
  const t = useT()
  return (
    <Screen title="终端" testID="terminal">
      <Empty title={t('app.todo')} />
    </Screen>
  )
}
