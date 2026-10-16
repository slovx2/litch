// 对话区里的条目要往外做的事，由对话区统一给：分叉之后打开新会话，以及现在是不是有回合在进行。
import { createContext, useContext } from 'react'

export interface TranscriptActions {
  /** 这个会话里有回合在进行。这时分叉、回退、压缩都做不了 */
  busy: boolean
  /** 打开另一个会话。只读地看已归档的对话时没有 */
  open?: ((selection: { deviceId: string; sessionId: string }) => void) | undefined
}

const Context = createContext<TranscriptActions>({ busy: false })

export const ActionsProvider = Context.Provider

export const useActions = () => useContext(Context)
