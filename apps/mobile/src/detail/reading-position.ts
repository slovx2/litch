// 倒置对话记“贴底”或消息锚点；绝对偏移会随新消息、尾巴搬家和重新测量而过时。
import type { FlashListRef } from '@shopify/flash-list'
import type { Row } from '../core/rows'
import { offsetFor, topOf } from './keep-place'

export type ReadingPosition = { kind: 'bottom' } | { kind: 'anchor'; key: string; top: number }

export interface ReadingMemory {
  position: ReadingPosition
}

const memories = new WeakMap<object, Map<string, ReadingMemory>>()

/** 跟核心实例隔离，换设备装法不继承上一份模拟/真实会话的位置。 */
export function readingMemory(owner: object, device: string, session: string): ReadingMemory {
  let entries = memories.get(owner)
  if (!entries) memories.set(owner, (entries = new Map()))
  const key = JSON.stringify([device, session])
  let memory = entries.get(key)
  if (!memory) {
    memory = { position: { kind: 'bottom' } }
    entries.set(key, memory)
  }
  return memory
}

type List = Pick<
  FlashListRef<Row>,
  | 'props'
  | 'getLayout'
  | 'getFirstItemOffset'
  | 'getAbsoluteLastScrollOffset'
  | 'scrollToOffset'
  | 'computeVisibleIndices'
>

/** 只在可见且已恢复的列表上取样；隐藏和首帧布局产生的偏移不能覆盖用户的阅读意图。 */
export function readPosition(list: List, anchorFrom = 0): ReadingPosition | null {
  if (list.getAbsoluteLastScrollOffset() <= 48) return { kind: 'bottom' }
  const { startIndex, endIndex } = list.computeVisibleIndices()
  const index = Math.max(0, anchorFrom, startIndex)
  if (index > endIndex) return null
  const row = list.props.data?.[index]
  if (!row) return null
  const top = topOf(list, row.key)
  return top === null ? null : { kind: 'anchor', key: row.key, top }
}

/** 用当前布局换算目标；消息尚未挂载时继续等待，不把未知当成底部。 */
export function readingOffset(list: List, position: ReadingPosition): number | null {
  return position.kind === 'bottom' ? 0 : offsetFor(list, position.key, position.top)
}
