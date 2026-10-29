// 紧凑卡片的展开状态按会话与条目记住，虚拟列表卸载或切换会话不丢失。
import { useCallback, useSyncExternalStore } from 'react'
import { useTranscript } from './context'

const opened = new Set<string>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCardOpen(id: string): [boolean, () => void] {
  const { deviceId, sessionId } = useTranscript()
  const key = JSON.stringify([deviceId, sessionId, id])
  const open = useSyncExternalStore(subscribe, () => opened.has(key))
  const toggle = useCallback(() => {
    if (!opened.delete(key)) opened.add(key)
    for (const listener of listeners) listener()
  }, [key])
  return [open, toggle]
}
