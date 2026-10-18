// 设置里“成功了也通知”那一项：存在这台电脑的本地存储里（通知是这台电脑发的，不是设备上的设置）。
// 默认关着：只有失败的运行发系统通知。存不进去（隐私模式之类）就按默认的来。
import { useSyncExternalStore } from 'react'

const KEY = 'litch.notify.taskSuccess'
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

let current = read()

export const notifySuccess = (): boolean => current

export function setNotifySuccess(on: boolean): void {
  current = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useNotifySuccess = (): boolean => useSyncExternalStore(subscribe, notifySuccess)
