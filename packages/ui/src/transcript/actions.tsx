// 对话区里的条目要往外做的事，由对话区统一给：分叉之后打开新会话，以及现在是不是有回合在进行。
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react'

export interface TranscriptActions {
  /** 这个会话里有回合在进行。这时分叉、回退、压缩都做不了 */
  busy: boolean
  /** 打开另一个会话。只读地看已归档的对话时没有 */
  open?: ((selection: { deviceId: string; sessionId: string }) => void) | undefined
}

function busyStore(initial = false) {
  let busy = initial
  const listeners = new Set<() => void>()
  return {
    read: () => busy,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(value: boolean) {
      if (value === busy) return
      busy = value
      for (const listener of listeners) listener()
    },
  }
}
const BusyContext = createContext(busyStore())
const OpenContext = createContext<TranscriptActions['open']>(undefined)

/** 回合忙闲不改变“打开会话”，避免一次发送使历史里的回报、会话引用和卡片全部重画。 */
export function ActionsProvider({
  value,
  children,
}: {
  value: TranscriptActions
  children: ReactNode
}) {
  const [state] = useState(() => busyStore(value.busy))
  useLayoutEffect(() => state.set(value.busy), [state, value.busy])
  return (
    <OpenContext.Provider value={value.open}>
      <BusyContext.Provider value={state}>{children}</BusyContext.Provider>
    </OpenContext.Provider>
  )
}

export const useOpenSession = () => useContext(OpenContext)
export const useActions = () => {
  const state = useContext(BusyContext)
  return {
    busy: useSyncExternalStore(state.subscribe, state.read, state.read),
    open: useOpenSession(),
  }
}
