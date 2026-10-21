// “回合进行中发消息”这一项记在这台电脑的界面里（litch.compose），和外观、链接怎么开一样不经核心，全局一份。
// 判断在 send-mode-logic.ts。验收和开发时在控制台里换它用 window.__litchSendMode（走的就是设置页用的那个函数）。
import { useSyncExternalStore } from 'react'
import { readSendMode, type SendMode } from './send-mode-logic.ts'

const STORAGE_KEY = 'litch.compose'

function readSaved(): SendMode {
  try {
    return readSendMode(localStorage.getItem(STORAGE_KEY))
  } catch {
    return readSendMode(null)
  }
}

let current = readSaved()
const listeners = new Set<() => void>()
const publish = (next: SendMode) => {
  current = next
  for (const listener of listeners) listener()
}

// 别的窗口改了这一项：跟着变
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) publish(readSaved())
})

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useSendMode = (): SendMode => useSyncExternalStore(subscribe, () => current)

export function setSendMode(mode: SendMode): void {
  if (mode === current) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode }))
  } catch {
    // 记不下来不影响这一次
  }
  publish(mode)
}

export interface SendModeHandle {
  get(): SendMode
  set(mode: SendMode): void
}

declare global {
  interface Window {
    __litchSendMode?: SendModeHandle
  }
}

window.__litchSendMode = { get: () => current, set: setSendMode }
