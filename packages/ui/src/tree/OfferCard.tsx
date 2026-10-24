// 对话流里的 offer 卡：用户这条消息和当前会话无关时，模型先只带标题调 litch_sessions.start（initiation offer），
// 卡上问“要单开一个会话吗”，两个按钮“新会话”“在这里做”；那次调用一直等到用户选。
// 选了新会话：卡上写“等模型补简报”，模型用 accept 补上简报起出子会话后写“已开始”，下面一行是实际的子会话；
// 选了在这里做（或者没选就又发了话、回合停了）：写“在这里做”。
// 选了新会话、模型补的简报要开到收不紧沙箱的 harness 上时，设备进程不开，卡片带着简报降成普通提案（pending）：
// 写明没直接开的原因（换了 harness、沙箱收不紧），按钮同普通提案卡，由用户看过再点。
// 调用还在等的时候结果里没有提案号，按提案的 callId（就是这一条的条目 id）对上提案。
// 侧面板“建议任务”里 offer 那一行用同一套按钮（OfferActs）。
import {
  type DeviceView,
  keys,
  type ProposalStarts,
  proposalShape,
  proposalStatus,
  type SessionProposalView,
  type SessionSummary,
  type ToolCallItem,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { nameOf } from '../app/device.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import type { ItemRef } from '../transcript/messages.tsx'
import { useWorktreesOn, WorktreeCheck } from '../worktrees/WorktreeCheck.tsx'
import { findOffer, offerState } from './offer.ts'
import { Brief, ProposalActs, ProposalMeta, StartedChild } from './ProposalCard.tsx'
import { STATUS_TEXT, useProposalAct, useProposalClock, useProposalList } from './proposals.ts'
import { SANDBOX_LEVEL } from './sandbox.ts'

/** “新会话”“在这里做”两个按钮，和没做成时的那句话。卡片和侧面板共用 */
export function OfferActs({
  deviceId,
  sessionId,
  proposal,
  small,
}: {
  deviceId: string
  sessionId: string
  proposal: SessionProposalView
  small?: boolean
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const act = useProposalAct(deviceId, sessionId, proposal.id)
  const [worktree, setWorktree] = useState(proposal.worktree ?? proposal.worktreeDefault)
  const worktrees = useWorktreesOn(deviceId)
  const off = act.busy || device?.connection !== 'online'
  return (
    <>
      <div className="prop-acts" data-small={small === true}>
        <button
          type="button"
          className="btn primary"
          data-act="session"
          disabled={off}
          onClick={() => act.answer('session', worktrees ? worktree : undefined)}
        >
          {t('proposal.offer.session')}
        </button>
        <button
          type="button"
          className="btn"
          data-act="here"
          disabled={off}
          onClick={() => act.answer('here')}
        >
          {t('proposal.offer.here')}
        </button>
        <WorktreeCheck
          deviceId={deviceId}
          checked={worktree}
          disabled={off}
          onChange={setWorktree}
        />
      </div>
      {act.failure ? <p className="prop-err err">{act.failure}</p> : null}
    </>
  )
}

/** litch_sessions.start（initiation offer）的那一条 */
export function OfferCard({ deviceId, sessionId, itemId, item }: ItemRef & { item: ToolCallItem }) {
  const t = useT()
  const spawned = item.spawned
  const list = useProposalList(deviceId, sessionId)
  const now = useProposalClock(list)
  const proposal = findOffer(list, itemId, spawned?.proposalId ?? null)
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  if (!spawned) return null
  const proposalId = proposal?.id ?? spawned.proposalId ?? ''
  const childId = proposal?.startedId ?? (proposalId ? starts?.[proposalId] : undefined) ?? ''
  const failed = item.status === 'failed' || item.error !== null
  const state = offerState({
    status: proposal ? proposalStatus(proposal, now) : null,
    childId,
    choice: spawned.choice,
    failed,
  })
  const status = state === 'failed' ? null : state
  const title = proposal?.title || spawned.title
  // 降成了普通提案（补的简报开到收不紧的 harness 上）：带简报、等用户点
  const held = status === 'pending' && proposal !== undefined ? proposal : null
  const stateText = status
    ? t(STATUS_TEXT[status])
    : failed
      ? t('proposal.offer.failed')
      : item.status === 'inProgress'
        ? t('proposal.offer.waiting')
        : ''
  return (
    <div
      className="tree-card prop-card offer-card"
      data-card="offer"
      data-proposal={proposalId || undefined}
      data-item={itemId}
      data-state={state ?? ''}
      data-anchor={`i:${itemId}`}
    >
      <div className="prop-body">
        <span className="tree-card-kind">
          <Icon name="suggest" small />
          <span className="grow">{t('proposal.offer.kind')}</span>
          {stateText ? <span className="prop-state">{stateText}</span> : null}
        </span>
        <b className="prop-title">{title}</b>
        {status === 'offered' || (status === null && !failed) ? (
          <p className="prop-ask">{t('proposal.offer.ask')}</p>
        ) : null}
        {status === 'chosen' ? (
          <p className="prop-ask dim">{t('proposal.offer.briefing')}</p>
        ) : null}
        {status === 'here' ? <p className="prop-ask dim">{t('proposal.offer.doneHere')}</p> : null}
        {held ? (
          <ProposalMeta
            deviceId={deviceId}
            shape={proposalShape(held, null, parent?.harness ?? null)}
          />
        ) : null}
        {status === 'started' || held ? (
          <Brief prompt={proposal?.prompt ?? ''} background={proposal?.background ?? ''} />
        ) : null}
        {held ? (
          <p className="prop-wider" data-held="true" data-wider={held.widerSandbox ?? ''}>
            {t('proposal.offer.held', {
              harness: nameOf(device, held.harness ?? parent?.harness ?? ''),
              level: held.widerSandbox ? t(SANDBOX_LEVEL[held.widerSandbox]) : '',
            })}
          </p>
        ) : null}
        {held ? <ProposalActs deviceId={deviceId} sessionId={sessionId} proposal={held} /> : null}
        {status === 'offered' && proposal ? (
          <OfferActs deviceId={deviceId} sessionId={sessionId} proposal={proposal} />
        ) : null}
      </div>
      {status === 'started' && childId ? (
        <StartedChild deviceId={deviceId} childId={childId} title={title} />
      ) : null}
    </div>
  )
}
