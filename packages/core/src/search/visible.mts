import type { ItemView, TurnView } from '../model.mjs'
import { blockInput, bucketItems } from '../projection/blocks.mjs'

/** 与两端对话分块使用同一份规则；提醒回合、尚未出现的收尾卡不能产生隐藏命中。 */
export function searchableItems(turn: TurnView, items: readonly ItemView[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const block of bucketItems(
    items.map((item) => blockInput(item.id, item)),
    { turnRunning: turn.status === 'running' },
  )) {
    if ('itemId' in block) ids.add(block.itemId)
    else if ('itemIds' in block) for (const id of block.itemIds) ids.add(id)
    else if (block.type === 'process')
      for (const part of block.parts) {
        if ('itemId' in part) ids.add(part.itemId)
        else for (const id of part.itemIds) ids.add(id)
      }
  }
  return ids
}
