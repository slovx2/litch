// 手机批准的卡片从哪来、答复往哪送：都经核心（packages/core/src/device/approvals.mts）。会话页开着时订阅这台设备的
// 卡片（replica.openApprovals → keys.approvals），核心跟着设备的 litch/approval/list 和 changed；答复原样经 approval.answer
// 交给设备（litch/approval/answer），验签是桌面端的事。
import { type ApprovalsTopicView, type CoreChannel, keys } from '@litch/core'
import { useEffect, useMemo } from 'react'
import type {
  ApprovalAnswer,
  ApprovalCardView,
} from '../../../../../packages/protocol/src/client-approvals.mts'
import { useKey, useReplica } from '../../shell/services'

const NONE: readonly ApprovalCardView[] = []

/** 这个会话现在挂着的登录卡片，先开的在前 */
export function useApprovalCards(deviceId: string, sessionId: string): readonly ApprovalCardView[] {
  const replica = useReplica()
  useEffect(() => replica.openApprovals(deviceId), [replica, deviceId])
  const topic = useKey<ApprovalsTopicView>(keys.approvals(deviceId))
  return useMemo(() => {
    const mine = topic?.cards.filter((card) => card.threadId === sessionId) ?? []
    return mine.length > 0 ? mine : NONE
  }, [topic, sessionId])
}

export const sendApprovalAnswer = (
  channel: CoreChannel,
  deviceId: string,
  answer: ApprovalAnswer,
): Promise<unknown> => channel.command('approval.answer', { deviceId, answer })

/** 设备说没有这张卡片了（电脑上答过、回合结束、过期） */
export const isGone = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'notFound'
