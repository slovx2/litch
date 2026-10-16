// 投影的第三步：一个回合里的显示条目 → 块。纯函数。
// 界面按块画：用户消息、回答、计划、待办进度各占一块；推理、命令、改文件、工具调用这些过程性的条目
// 连在一起收成一个“活动”块，可以整体折叠（设计文档 02 第 2.4 节）。
import type { ItemView } from '../model.mjs'

/** 分块只需要知道条目的标识和种类；助手消息还要知道它是过程说明还是回答 */
export interface BlockInput {
  id: string
  kind: ItemView['kind']
  phase?: 'commentary' | 'final' | 'unknown'
}

export type Block =
  | { type: 'user'; itemId: string }
  | { type: 'answer'; itemId: string }
  | { type: 'plan'; itemId: string }
  | { type: 'todo'; itemId: string }
  /** key 是组里第一个条目的标识，组里再加条目它也不变 */
  | { type: 'activity'; key: string; itemIds: string[] }
  /** 整个回合只有说明（手动压缩上下文的那个回合就是这样）：说明直接露在外面，不收进“活动”里 */
  | { type: 'notes'; key: string; itemIds: string[] }

export function bucketItems(items: BlockInput[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    if (item.kind === 'userMessage') {
      blocks.push({ type: 'user', itemId: item.id })
    } else if (item.kind === 'plan') {
      blocks.push({ type: 'plan', itemId: item.id })
    } else if (item.kind === 'todo') {
      // 待办进度一直露在外面，不跟着活动区收起来
      blocks.push({ type: 'todo', itemId: item.id })
    } else if (item.kind === 'agentMessage' && item.phase !== 'commentary') {
      // 分不清阶段的（unknown）按回答显示：宁可多露出一段文字，也不能把回答藏进折叠里
      blocks.push({ type: 'answer', itemId: item.id })
    } else {
      // 过程说明和其余过程性的条目进活动块
      const last = blocks[blocks.length - 1]
      if (last?.type === 'activity') last.itemIds.push(item.id)
      else blocks.push({ type: 'activity', key: item.id, itemIds: [item.id] })
    }
  }
  // 回合里除了说明什么都没有：收起来就只剩“活动 1 步”，等于什么都没告诉用户
  const only = blocks.length === 1 ? blocks[0] : undefined
  if (only?.type === 'activity' && items.every((item) => item.kind === 'notice'))
    return [{ type: 'notes', key: only.key, itemIds: only.itemIds }]
  return blocks
}

/**
 * 活动块现在该不该自动收起来（用户没有手动点过的时候）。
 * 回合结束了就收；回合还在进行时，只要后面已经有一条写完的最终回答也收。
 * “刚开始就说自己是最终回答”的消息只在 finalOnStart 为真时采信：harness 声明了消息一开始阶段值就是准的
 *（原生 codex），最终回答一开始就收。没声明的不信——前置验证 P6 的结论是 Claude Code 和 Pi 都要等消息写完才分得清。
 */
export function activitySettled(
  turnRunning: boolean,
  after: { kind: ItemView['kind']; phase?: string; status?: string }[],
  finalOnStart = false,
): boolean {
  if (!turnRunning) return true
  return after.some(
    (item) =>
      item.kind === 'agentMessage' &&
      item.phase === 'final' &&
      (finalOnStart || item.status === 'completed'),
  )
}
