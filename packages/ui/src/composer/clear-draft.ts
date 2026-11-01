import type { ImageAttachment, MessageExtra } from '@litch/core'
import type { Platform } from '../app/platform.ts'
import type { DiffNote } from '../diff/annotations.ts'
import type { DraftComment } from './drafts.ts'

export interface DraftSnapshot {
  text: string
  images: ImageAttachment[]
  extras: MessageExtra[]
  comments: DraftComment[]
  notes: readonly DiffNote[]
}

export const hasDraft = (draft: DraftSnapshot): boolean =>
  Boolean(
    draft.text ||
      draft.images.length ||
      draft.extras.length ||
      draft.comments.length ||
      draft.notes.length,
  )

/** 只接管 macOS 的 Ctrl+C 和对应撤销；其他系统的复制始终交给浏览器。 */
export function draftShortcut(
  platform: Platform,
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode'
  >,
): 'clear' | 'undo' | null {
  if (
    platform !== 'mac' ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.shiftKey
  )
    return null
  if (event.key.toLowerCase() === 'c' && event.ctrlKey && !event.metaKey) return 'clear'
  if (event.key.toLowerCase() === 'z' && event.metaKey && !event.ctrlKey) return 'undo'
  return null
}
