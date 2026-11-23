import {
  type DeviceView,
  explicitFileRef,
  keys,
  pathTwin,
  type SessionSummary,
  sessionFileScope,
  type WorkspaceView,
} from '@litch/core'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { ManagerView } from '../../../../../packages/core/src/model-manager.mts'
import type { RootStackParamList } from '../../nav/routes'
import { useKey } from '../../shell/services'
import { useT } from '../../ui/i18n'

/** 和对话里的文件引用一样，由文件页在这条会话所属的设备上核实路径。 */
export function useBoardFile(manager: ManagerView | undefined) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(manager?.deviceId ?? ''))
  const summary = useKey<SessionSummary>(
    keys.summary(manager?.deviceId ?? '', manager?.threadId ?? ''),
  )
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(manager?.deviceId ?? ''))
  return (href: string) => {
    if (!manager) return
    const workspaceId = summary?.workspaceId ?? null
    const scope = sessionFileScope(
      summary ?? { cwd: manager.cwd },
      workspaces?.find((workspace) => workspace.id === workspaceId)?.roots,
      pathTwin(device?.os),
    )
    const ref = scope && explicitFileRef(href, scope)
    if (!scope || !ref) throw new Error(t('manager.linkUnavailable'))
    navigation.navigate('Files', {
      deviceId: manager.deviceId,
      sessionId: manager.threadId,
      workspaceId,
      root: scope.root,
      path: ref.path,
      ref,
      href,
      ...(ref.line === null ? {} : { line: ref.line }),
      ...(ref.fragment ? { fragment: ref.fragment } : {}),
    })
  }
}
