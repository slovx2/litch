// 改动：主线只放了占位，工具页线接手。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'Diff'>

export function DiffScreen(_props: Props) {
  const t = useT()
  return (
    <Screen title="改动" testID="diff">
      <Empty title={t('app.todo')} />
    </Screen>
  )
}
