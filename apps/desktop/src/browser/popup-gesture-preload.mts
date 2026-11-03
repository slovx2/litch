// Electron 的开窗回调只有 disposition，没有 userGesture。隔离环境只报告真实输入的当前任务，
// 不改写 window.open，也不把桥暴露给网页；定时器里的弹窗不继承上一次点击的前台意图。
import { ipcRenderer } from 'electron'
import { POPUP_GESTURE } from './popup-gesture.mjs'

let sequence = 0
const note = (event: MouseEvent | KeyboardEvent) => {
  if (!event.isTrusted) return
  if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return
  const token = ++sequence
  const background =
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey || (event instanceof MouseEvent && event.button === 1))
  ipcRenderer.send(POPUP_GESTURE, { token, active: true, background })
  setTimeout(() => ipcRenderer.send(POPUP_GESTURE, { token, active: false }), 0)
}
for (const name of ['pointerdown', 'pointerup', 'click', 'auxclick'] as const) {
  window.addEventListener(name, note, true)
}
window.addEventListener('keydown', note, true)
