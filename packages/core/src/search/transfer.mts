import type { ItemView } from '../model.mjs'

/** 搜索执行器只接显示文字；图片数据与工具原始输入输出不随快照克隆。 */
export function searchTransferItem(item: ItemView): ItemView {
  if (item.kind === 'toolCall') return { ...item, input: [], output: [], error: null }
  if (item.kind === 'userMessage')
    return { ...item, attachments: item.attachments.map(({ kind, label }) => ({ kind, label })) }
  return item
}
