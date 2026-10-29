import { native } from '../../modules/litch-ssh/src/native'

export const BACKGROUND_MINUTES = [1, 5, 10, 30, 60] as const
export function backgroundMinutes(value: unknown): number | null {
  if (value === null) return null
  return BACKGROUND_MINUTES.some((minutes) => minutes === value) ? (value as number) : 10
}

interface PolicyState {
  revision: number
  background: boolean
  suspended: boolean
}

/** 原生事件可能在 JS 恢复时才送来，旧事件不能把已回前台的核心再次暂停。 */
export function watchConnections(setPaused: (paused: boolean) => void): () => void {
  let revision = -1
  const update = () => {
    const state = JSON.parse(native.connectionPolicyState()) as PolicyState
    if (state.revision <= revision) return
    revision = state.revision
    setPaused(state.suspended)
  }
  const listener = native.addListener('onConnectionPolicy', update)
  update()
  return () => listener.remove()
}

export function setBackgroundMinutes(minutes: number | null): void {
  native.setBackgroundTimeout(minutes ?? 0)
}

export function batteryState(): ReturnType<typeof native.batteryOptimization> {
  try {
    return native.batteryOptimization()
  } catch {
    return 'unknown'
  }
}

export function openBatterySettings(): boolean {
  try {
    return native.openBackgroundSettings()
  } catch {
    return false
  }
}
