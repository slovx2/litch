// 限时授权：订阅会话所在设备上生效的名单（核心的 timedApprovals 主题）。判定与代答在设备和桌面端，
// 手机只授予、展示和撤销；授权记在设备上，桌面、手机看到同一份。
import type { TimedApprovalsView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useChannel } from '../../shell/services'

export {
  timedWhat,
  untilText,
} from '../../../../../packages/ui/src/timed/text.ts'

export function useTimedApprovals(deviceId: string): TimedApprovalsView | undefined {
  const channel = useChannel()
  const [view, setView] = useState<TimedApprovalsView>()
  useEffect(() => {
    setView(undefined)
    return channel.subscribe(
      { kind: 'timedApprovals', deviceId },
      {
        snapshot: (data) => setView(data),
        delta: () => {},
        error: () => setView(undefined),
      },
    )
  }, [channel, deviceId])
  return view
}
