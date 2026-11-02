// 会话详情页：标题栏加会话页面内容（session-page.tsx）。工作线的会话副标题前半段是“↰ 经理名”，点了回到经理（manager-origin.ts）。
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../nav/routes'
import { Screen } from '../ui/kit/Screen'
import { useSessionPage } from './session-page'

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>

export function DetailScreen({ route }: Props) {
  const { deviceId, sessionId, title } = route.params
  const page = useSessionPage({ deviceId, sessionId, title })
  return (
    <Screen
      title={page.title}
      subtitle={page.subtitle}
      subtitleLink={page.subtitleLink}
      wire={page.wire}
      actions={page.actions}
      testID="detail"
    >
      {page.body}
      {page.overlays}
    </Screen>
  )
}
