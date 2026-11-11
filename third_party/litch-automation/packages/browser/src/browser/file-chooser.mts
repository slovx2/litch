import type { FileChooserInfo, FileChooserInterception } from './model.mjs'

/** 两种宿主共用的有界监听；超时、取消、失败都撤订阅并恢复选择器设置。 */
export async function interceptFileChooser(
  send: (enabled: boolean) => Promise<unknown>,
  subscribe: (listener: (info: FileChooserInfo) => void) => () => void,
  signal: AbortSignal,
): Promise<FileChooserInterception> {
  signal.throwIfAborted()
  let received: FileChooserInfo | null = null
  let wake: (() => void) | undefined
  const off = subscribe((info) => {
    received ??= info
    wake?.()
  })
  const abort = () => wake?.()
  signal.addEventListener('abort', abort, { once: true })
  const dispose = async () => {
    off()
    signal.removeEventListener('abort', abort)
    await send(false)
  }
  try {
    await send(true)
    signal.throwIfAborted()
  } catch (error) {
    await dispose().catch(() => {})
    throw error
  }
  return {
    async wait(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!received && !signal.aborted)
          await new Promise<void>((resolve) => {
            wake = resolve
            timer = setTimeout(resolve, timeoutMs)
          })
        signal.throwIfAborted()
        return received
      } finally {
        wake = undefined
        clearTimeout(timer)
      }
    },
    dispose,
  }
}
