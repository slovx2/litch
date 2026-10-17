// 一台设备上的工作区和会话。主线搭的最小版本（按最近动过排、点进详情、新会话入口），会话列表线接手后补全：
// 按工作区分组（keys.groups、keys.workspaces）、置顶和分区、已归档、未读和等人的记号、长按菜单（改名、归档、删除）。
import { type DeviceView, keys, type SessionSummary } from '@litch/core'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import { useMemo } from 'react'
import { FlatList } from 'react-native'
import type { RootStackParamList } from '../../nav/routes'
import { useKey, useReplica } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { Empty, Row } from '../../ui/kit/controls'
import { Screen } from '../../ui/kit/Screen'
import { useTheme } from '../../ui/theme'

type Props = NativeStackScreenProps<RootStackParamList, 'Sessions'>

function SessionRow({
  deviceId,
  sessionId,
  onPress,
}: {
  deviceId: string
  sessionId: string
  onPress(session: SessionSummary): void
}) {
  const session = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const t = useT()
  if (!session) return null
  return (
    <Row
      testID={`session:${sessionId}`}
      title={t.text(session.title)}
      detail={session.cwd}
      meta={session.status}
      onPress={() => onPress(session)}
    />
  )
}

export function SessionsScreen({ navigation, route }: Props) {
  const { deviceId } = route.params
  const t = useT()
  const { c } = useTheme()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const groups = useKey<Record<string, string[]>>(keys.groups(deviceId))
  const { store } = useReplica()
  const ids = useMemo(() => {
    const all = Object.values(groups ?? {}).flat()
    const at = (id: string) => store.get<SessionSummary>(keys.summary(deviceId, id))?.updatedAt ?? 0
    return all.sort((a, b) => at(b) - at(a))
  }, [groups, store, deviceId])
  return (
    <Screen
      title={device ? t.text(device.name) : deviceId}
      subtitle={device?.host}
      wire={device ? c.wire[device.wire] : undefined}
      actions={[
        {
          label: '＋',
          testID: 'sessions:new',
          onPress: () => navigation.navigate('NewSession', { deviceId }),
        },
      ]}
      testID="sessions"
    >
      <FlatList
        data={ids}
        keyExtractor={(id) => id}
        renderItem={({ item }) => (
          <SessionRow
            deviceId={deviceId}
            sessionId={item}
            onPress={(session) =>
              navigation.navigate('Detail', {
                deviceId,
                sessionId: session.id,
                title: t.text(session.title),
              })
            }
          />
        )}
        ListEmptyComponent={<Empty title={t('app.todo')} />}
      />
    </Screen>
  )
}
