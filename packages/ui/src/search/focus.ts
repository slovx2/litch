let cancelPending: (() => void) | undefined

/** 导航可能异步读会话；只聚焦这一次选中的输入框，用户开始别的操作时放弃。 */
export function focusSearchSession(deviceId: string, sessionId: string) {
  cancelPending?.()
  const selector = `.main [data-composer-session="${CSS.escape(JSON.stringify([deviceId, sessionId]))}"]`
  let frame = 0
  const stop = () => {
    observer.disconnect()
    clearTimeout(timeout)
    cancelAnimationFrame(frame)
    document.removeEventListener('pointerdown', stop, true)
    document.removeEventListener('keydown', stop, true)
    if (cancelPending === stop) cancelPending = undefined
  }
  const focus = () => {
    const input = document.querySelector<HTMLTextAreaElement>(selector)
    if (!input || input.disabled || !input.checkVisibility()) return
    input.focus({ preventScroll: true })
    stop()
  }
  const observer = new MutationObserver(focus)
  const timeout = window.setTimeout(stop, 5000)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true })
  document.addEventListener('pointerdown', stop, true)
  document.addEventListener('keydown', stop, true)
  cancelPending = stop
  frame = requestAnimationFrame(focus)
}
