// 文件：主线只放了占位，会话列表线接手。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../nav/routes'
import { useT } from '../../ui/i18n'
import { Empty } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'

type Props = NativeStackScreenProps<RootStackParamList, 'Files'>

export function FilesScreen(_props: Props) {
  const t = useT()
  return (
    <Screen title="文件" testID="files">
      <Empty title={t('app.todo')} />
    </Screen>
  )
}
