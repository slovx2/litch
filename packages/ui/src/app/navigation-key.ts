import type { Platform } from './platform.ts'

/** 编辑区的光标移动与输入法优先；终端的隐藏 textarea 也属于编辑区。 */
export function navigationKey(
  event: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'keyCode'
  >,
  platform: Platform,
  editing: boolean,
): -1 | 1 | null {
  if (editing || event.isComposing || event.keyCode === 229 || event.shiftKey) return null
  if (platform === 'mac') {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null
    return event.key === '[' ? -1 : event.key === ']' ? 1 : null
  }
  if (!event.altKey || event.ctrlKey || event.metaKey) return null
  return event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null
}
