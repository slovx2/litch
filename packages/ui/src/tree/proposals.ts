// 建议任务（模型提的子会话提案）在界面上的几样共用的东西：取列表、到点重画、开始和不要、
// 侧面板点一条时在对话流里找到那张卡片。卡片在 ProposalCard.tsx，侧面板的标签在 ProposalsTab.tsx。
import {
  keys,
  type OfferChoice,
  type ProposalOverrides,
  type ProposalStatus,
  proposalOpen,
  proposalStatus,
  type SessionProposalView,
} from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'

const NONE: readonly SessionProposalView[] = []

/** 这个会话上的全部提案（等着的、了结的）。还没取到是 undefined */
export const useProposalList = (
  deviceId: string,
  sessionId: string,
): readonly SessionProposalView[] | undefined =>
  useKey<SessionProposalView[]>(keys.proposals(deviceId, sessionId))

/**
 * 现在的时刻。等着的提案里最早过期的那一刻重画一次，卡片、角标从“等开始”变成“过期了”。
 * 定时器的上限是 2^31 毫秒（二十多天）：七天的提案在这之内
 */
export function useProposalClock(list: readonly SessionProposalView[] | undefined): number {
  const [, redraw] = useState(0)
  const now = Date.now()
  const next = Math.min(
    ...(list ?? NONE)
      .filter((proposal) => proposal.status === 'pending' && proposal.expiresAt > now)
      .map((proposal) => proposal.expiresAt),
  )
  useEffect(() => {
    if (!Number.isFinite(next)) return
    const timer = window.setTimeout(() => redraw((n) => n + 1), Math.max(0, next - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [next])
  return now
}

/**
 * 侧面板的排法：没了结的在上（等开始的提案、等选的 offer 卡、选了新会话等模型补简报的，先提的在前），
 * 了结的在下（刚了结的在前）
 */
export function arrange(
  list: readonly SessionProposalView[],
  now: number,
): { pending: SessionProposalView[]; settled: SessionProposalView[] } {
  const pending = list.filter((proposal) => proposalOpen(proposalStatus(proposal, now)))
  const settled = list
    .filter((proposal) => !proposalOpen(proposalStatus(proposal, now)))
    .sort(
      (a, b) =>
        (b.settledAt ?? b.expiresAt) - (a.settledAt ?? a.expiresAt) || b.createdAt - a.createdAt,
    )
  return { pending, settled }
}

/** 每种状态的那句话 */
export const STATUS_TEXT = {
  pending: 'proposal.state.pending',
  offered: 'proposal.state.offered',
  chosen: 'proposal.state.chosen',
  here: 'proposal.state.here',
  started: 'proposal.state.started',
  dismissed: 'proposal.state.dismissed',
  withdrawn: 'proposal.state.withdrawn',
  expired: 'proposal.state.expired',
} as const satisfies Record<ProposalStatus, string>

/**
 * 一张提案上的“开始”“在这里做”“不要”，offer 卡上的“新会话”“在这里做”：发出去、等着、没做成的原因。
 * 提案卡的“在这里做”由设备进程往这个会话发“在这里做：”（界面语言）加标题和任务，回合在跑就插进那个回合
 */
export function useProposalAct(deviceId: string, sessionId: string, proposalId: string) {
  const { channel } = useServices()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = (sent: Promise<unknown>) => {
    setBusy(true)
    setFailure(null)
    sent
      .catch((error: unknown) => setFailure(t('proposal.failed', { reason: whyNot(error, t) })))
      .finally(() => setBusy(false))
  }
  return {
    busy,
    failure,
    accept: (overrides?: ProposalOverrides) =>
      run(
        channel.command('session.proposal.accept', {
          deviceId,
          sessionId,
          proposalId,
          ...(overrides ? { overrides } : {}),
        }),
      ),
    dismiss: () =>
      run(channel.command('session.proposal.dismiss', { deviceId, sessionId, proposalId })),
    answer: (choice: OfferChoice) =>
      run(channel.command('session.proposal.answer', { deviceId, sessionId, proposalId, choice })),
    here: () =>
      run(
        channel.command('session.proposal.here', {
          deviceId,
          sessionId,
          proposalId,
          lead: t('proposal.here.lead'),
        }),
      ),
  }
}

/** 闪一下：找到的那一处标上 data-flash，过一会儿拿掉（样式里画一圈强调色） */
export function flash(element: Element): void {
  element.setAttribute('data-flash', '')
  window.setTimeout(() => element.removeAttribute('data-flash'), 1600)
}

/**
 * 在主区的对话流里找到这张提案的卡片，滚到眼前、闪一下。先按提案号找，找不到按提出它的那次调用（callId）找。
 * 对话里没有（还没载入、或者调用没留下来）返回 false
 */
export function revealProposal(proposal: SessionProposalView): boolean {
  const scope = document.querySelector('.main .tr')
  if (!scope) return false
  const card =
    scope.querySelector(`[data-proposal="${CSS.escape(proposal.id)}"]`) ??
    (proposal.callId
      ? scope.querySelector(
          `[data-item="${CSS.escape(proposal.callId)}"], [data-item$=":${CSS.escape(proposal.callId)}"]`,
        )
      : null)
  if (!card) return false
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  card.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
  flash(card)
  return true
}
