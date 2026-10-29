import { useEffect } from 'react'
import { useServices } from '../app/services.tsx'
import { showSideTabPassive } from '../side/side.ts'
import type { SidePlace } from '../side/tabs.ts'

// 只观察当前会话的活动，不订阅视频；手动隐藏后同一轮不反复打开。
export function useAutomationPreviewCue(place: SidePlace | null, available: boolean) {
  const { channel } = useServices()
  useEffect(() => {
    if (!available || !place?.sessionId) return
    let offered = false
    return channel.subscribe(
      {
        kind: 'automationPreview',
        deviceId: place.deviceId,
        sessionId: place.sessionId,
        observeOnly: true,
      },
      {
        snapshot(view) {
          if (!view) {
            offered = false
            return
          }
          if ((view.surface || view.status === 'capturePending') && !offered) {
            offered = true
            showSideTabPassive('automationPreview')
          }
        },
        delta: () => {},
      },
    )
  }, [channel, available, place?.deviceId, place?.sessionId])
}
