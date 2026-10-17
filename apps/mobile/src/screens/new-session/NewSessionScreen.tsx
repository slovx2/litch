// 新会话：主线只放了占位，输入线接手。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'NewSession'>

export function NewSessionScreen(_props: Props) {
  const t = useT()
  return (
    <Screen title="新会话" testID="new-session">
      <Empty title={t('app.todo')} />
    </Screen>
  )
}
