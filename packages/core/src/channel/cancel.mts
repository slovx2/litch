// 核心自己的取消信号。核心的编译环境里没有 AbortController 的类型，所以自己实现一个最小的。
import type { AbortSignalLike } from './protocol.mjs'

export interface Cancel {
  readonly signal: AbortSignalLike
  abort(): void
}

export function createCancel(): Cancel {
  let aborted = false
  const listeners: (() => void)[] = []
  return {
    signal: {
      get aborted() {
        return aborted
      },
      // 与标准的 AbortSignal 有一处不同：已经取消之后再加的监听会立刻被调用
      addEventListener(_type, listener) {
        if (aborted) listener()
        else listeners.push(listener)
      },
    },
    abort() {
      if (aborted) return
      aborted = true
      for (const listener of listeners.splice(0)) listener()
    },
  }
}
