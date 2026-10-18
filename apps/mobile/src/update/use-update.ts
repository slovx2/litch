// 界面接更新状态的两个钩子：useUpdate() 订阅快照；useUpdateSchedule() 挂定时查（设备列表是首页、一直在栈底，挂在那里）。
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useServices } from '../shell/services'
import { getUpdate, startUpdateSchedule, subscribeUpdate, type UpdateSnapshot } from './store'

export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(subscribeUpdate, getUpdate)
}

/** 按“自动检查更新”开关定时查；开关经 ref 读，换了不用重挂（重挂会把启动后那 30 秒重新算） */
export function useUpdateSchedule(): void {
  const { prefs } = useServices()
  const auto = useRef(prefs.autoUpdate)
  auto.current = prefs.autoUpdate
  useEffect(() => startUpdateSchedule(() => auto.current), [])
}
