// 评论中枢（hub.ts）经上下文给到对话区和输入区。不在会话详情页里（新建会话页）时没有，用的地方当没有评论功能。
import type { FlashListRef } from '@shopify/flash-list'
import { createContext, type RefObject, useContext, useEffect, useSyncExternalStore } from 'react'
import type { Row } from '../../core/rows'
import type { CommentsHub } from './hub'

export const CommentsContext = createContext<CommentsHub | null>(null)

export const useComments = (): CommentsHub | null => useContext(CommentsContext)

const never = () => () => {}

/** 订阅中枢上的一项。没有中枢时一直是 fallback */
export function useHubValue<T>(
  hub: CommentsHub | null,
  pick: (hub: CommentsHub) => T,
  fallback: T,
): T {
  return useSyncExternalStore(hub ? hub.subscribe : never, () => (hub ? pick(hub) : fallback))
}

/** 这一行是不是刚跳过来、正在闪 */
export function useFlashedRow(key: string): boolean {
  const hub = useComments()
  return useHubValue(hub, (each) => each.flashed === key, false)
}

/** 每次多排出多少行更早的历史，找原文时用（和对话区的分页一样） */
const PAGE = 40

/**
 * 对话区里：有要滚过去的原文就滚过去、闪一下。在还没排出来的更早的历史里就先多排几页
 * （照建议任务的 useReveal）
 */
export function useCommentJump(
  listRef: RefObject<FlashListRef<Row> | null>,
  all: Row[],
  limit: number,
  setLimit: (limit: number) => void,
): void {
  const hub = useComments()
  const target = useHubValue(hub, (each) => each.jumpTo, null)
  useEffect(() => {
    if (!hub || !target) return
    const index = all.findIndex((row) => row.key === target)
    if (index < 0) {
      hub.takeJump()
      return
    }
    if (index >= limit) {
      setLimit(index + PAGE)
      return
    }
    hub.takeJump()
    listRef.current?.scrollToIndex({ index, viewPosition: 0.3, animated: true })
    hub.flash(target)
  }, [hub, target, all, limit, setLimit, listRef])
}
