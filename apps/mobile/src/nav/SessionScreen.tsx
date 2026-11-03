// 所有按会话 ID 打开的入口统一在这里分流；未确认身份前不挂普通对话，也不清未读。
import { sessionDestination, subscribeSessionDestination } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import { DetailScreen } from '../detail/DetailScreen'
import { useReplica } from '../shell/services'
import { useT } from '../ui/i18n'
import { Empty } from '../ui/kit/controls'
import { Screen } from '../ui/kit/Screen'
import type { RootStackParamList } from './routes'
import { resolvedSessionRoute } from './session-route'

type Props = NativeStackScreenProps<RootStackParamList, 'Detail'>

export function SessionScreen(props: Props) {
  const { route, navigation } = props
  const { deviceId, sessionId, title } = route.params
  const { store } = useReplica()
  const t = useT()
  const destination = useSyncExternalStore(
    useCallback(
      (changed) => subscribeSessionDestination(store, deviceId, sessionId, changed),
      [store, deviceId, sessionId],
    ),
    () => sessionDestination(store, deviceId, sessionId),
  )
  useLayoutEffect(() => {
    const target = resolvedSessionRoute(route.params, destination)
    if (target?.[0] === 'ManagerConsole') navigation.replace(...target)
  }, [destination, route.params, navigation])
  if (destination === null) return <DetailScreen {...props} />
  // replace 保留原入口下面的栈，返回一次即可离开工作台；不会留下一个普通对话中间页。
  return (
    <Screen title={title ?? ''} testID="session-opening">
      <Empty title={t('detail.sync.loading')} />
    </Screen>
  )
}
