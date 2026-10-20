// 侧面板的“建议任务”标签：眼前这个会话里模型提的全部提案。没了结的在上：等开始的提案能开始、改了再开始、不要，
// 等选的 offer 卡能选“新会话”“在这里做”，选了新会话、等模型补简报的只写状态；
// 了结的（开始了、在这里做、不要了、撤回了、过期了）在下面，可以收起来。点一条在对话流里找到那张卡片、滚过去闪一下；
// 对话里找不到（还没载入、调用没留下）就只让这一行闪一下。标签上的角标是等着的个数（ProposalsBadge.tsx）。
// 开始了的那行写实际起出来的子会话的 harness 和目录（proposalShape），不是提案原本的。
import {
  type DeviceView,
  keys,
  type ProposalStarts,
  type ProposalStatus,
  proposalShape,
  proposalStatus,
  type SessionProposalView,
  type SessionSummary,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { Caret } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { OfferActs } from './OfferCard.tsx'
import { ProposalActs } from './ProposalCard.tsx'
import {
  arrange,
  flash,
  revealProposal,
  STATUS_TEXT,
  useProposalClock,
  useProposalList,
} from './proposals.ts'

/** offer 卡还没有简报时第二行写什么：等选的写那一问，选了的写选了什么 */
const OFFER_LINE: Partial<
  Record<ProposalStatus, 'proposal.offer.briefing' | 'proposal.offer.doneHere'>
> = { chosen: 'proposal.offer.briefing', here: 'proposal.offer.doneHere' }

function ProposalRow({
  deviceId,
  sessionId,
  proposal,
  now,
  fallbackHarness,
}: {
  deviceId: string
  sessionId: string
  proposal: SessionProposalView
  now: number
  fallbackHarness: string | null
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const status = proposalStatus(proposal, now)
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  const childId = status === 'started' ? (proposal.startedId ?? starts?.[proposal.id] ?? '') : ''
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const shape = proposalShape(proposal, child, fallbackHarness)
  const harness = shape.harness
  return (
    <li
      className="prop-row"
      data-proposal={proposal.id}
      data-state={status}
      data-offer={proposal.offer || undefined}
    >
      <button
        type="button"
        className="prop-row-main"
        title={t('proposal.reveal')}
        onClick={(event) => {
          const row = event.currentTarget.closest('.prop-row')
          if (!revealProposal(proposal) && row) flash(row)
        }}
      >
        <span className="prop-row-line">
          <b className="ell grow">{proposal.title}</b>
          <span className="prop-state">{t(STATUS_TEXT[status])}</span>
        </span>
        <span className="prop-row-line dim">
          {harness ? (
            <span className="chip" title={nameOf(device, harness)}>
              {badgeOf(device, harness)}
            </span>
          ) : null}
          {shape.actual && shape.cwd ? (
            <span className="ell grow mono prop-cwd" data-actual title={shape.cwd}>
              {shape.cwd}
            </span>
          ) : proposal.offer && !proposal.prompt ? (
            <span className="ell grow">{t(OFFER_LINE[status] ?? 'proposal.offer.ask')}</span>
          ) : (
            <span className="ell grow">{proposal.prompt}</span>
          )}
        </span>
      </button>
      {status === 'pending' ? (
        <ProposalActs deviceId={deviceId} sessionId={sessionId} proposal={proposal} small />
      ) : null}
      {status === 'offered' ? (
        <OfferActs deviceId={deviceId} sessionId={sessionId} proposal={proposal} small />
      ) : null}
    </li>
  )
}

export function ProposalsTab({ place }: SideTabProps) {
  const t = useT()
  const { deviceId, sessionId } = place
  const list = useProposalList(deviceId, sessionId ?? '')
  const now = useProposalClock(list)
  const harness = useKey<SessionSummary>(keys.summary(deviceId, sessionId ?? ''))?.harness
  const [folded, setFolded] = useState(false)
  if (!sessionId || !list || list.length === 0) {
    return (
      <div className="side-none dim" data-side-focus tabIndex={-1}>
        {t('proposal.none')}
      </div>
    )
  }
  const { pending, settled } = arrange(list, now)
  const row = (proposal: SessionProposalView) => (
    <ProposalRow
      key={proposal.id}
      deviceId={deviceId}
      sessionId={sessionId}
      proposal={proposal}
      now={now}
      fallbackHarness={harness ?? null}
    />
  )
  return (
    <div className="props-tab" data-parent={sessionId}>
      {pending.length > 0 ? (
        <ul className="prop-list" aria-label={t('proposal.pending')}>
          {pending.map(row)}
        </ul>
      ) : (
        <div className="prop-empty dim">{t('proposal.nonePending')}</div>
      )}
      {settled.length > 0 ? (
        <>
          <button
            type="button"
            className="prop-fold"
            aria-expanded={!folded}
            onClick={() => setFolded(!folded)}
          >
            <Caret />
            {t('proposal.settled', { n: settled.length })}
          </button>
          {folded ? null : (
            <ul className="prop-list" aria-label={t('proposal.settledList')}>
              {settled.map(row)}
            </ul>
          )}
        </>
      ) : null}
    </div>
  )
}
