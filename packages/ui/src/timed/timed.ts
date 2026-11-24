// 限时授权在界面上用到的：订阅会话所在设备的名单（核心的 timedApprovals 主题）、类别的说法、到期时刻。
// 判定和代答都不在界面：原生审批由设备代答，客户端工具由核心按名单放行，界面只负责授予、展示、撤销。
import type { TimedApprovalsView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useServices } from '../app/services.tsx'

/** 订阅一台设备上生效的限时授权。还没到快照时是 undefined */
export function useTimedApprovals(deviceId: string): TimedApprovalsView | undefined {
  const { channel } = useServices()
  const [view, setView] = useState<TimedApprovalsView>()
  useEffect(() => {
    setView(undefined)
    return channel.subscribe({ kind: 'timedApprovals', deviceId } as never, {
      snapshot: (data: unknown) => setView(data as TimedApprovalsView),
      delta: () => {},
      error: () => setView(undefined),
    })
  }, [channel, deviceId])
  return view
}

export { CATEGORY_TEXT, untilText } from './text.ts'
