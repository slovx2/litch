// 对话流里的提案卡片（建议任务）：模型调 litch_sessions.start 降成提案的那一条画成这张卡片。
// 标题、harness、模型、目录、简报（长的可展开）、状态（等开始、已开始、不要了、撤回了、过期了），
// 沙箱收不紧时的提醒；等着的有“开始”“改了再开始”“不要”，开始了的能点进子会话。
// 状态取这个会话的提案列表（连了结的一起），对不上的再看侧栏里哪个子会话记着从这张提案开始。
// 侧面板“建议任务”里的每一行用的是同一套按钮（ProposalActs）。
import {
  type DeviceView,
  keys,
  type ProposalStarts,
  proposalStatus,
  type SessionProposalView,
  type SessionSummary,
  type ToolCallItem,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { badgeOf, nameOf } from '../app/device.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { useActions } from '../transcript/actions.tsx'
import type { ItemRef } from '../transcript/messages.tsx'
import { STATUS_TEXT, useProposalAct, useProposalClock, useProposalList } from './proposals.ts'
import { SpawnDialog } from './SpawnDialog.tsx'
import { SANDBOX_LEVEL } from './sandbox.ts'
import { markOf } from './TreeCards.tsx'

/** 简报长到要折起来：超过这么多字，或者有好几行 */
const LONG_BRIEF = 160

/** “开始”“改了再开始”“不要”三个按钮，和没做成时的那句话。卡片和侧面板共用 */
export function ProposalActs({
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
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const act = useProposalAct(deviceId, sessionId, proposal.id)
  const [editing, setEditing] = useState(false)
  const off = act.busy || device?.connection !== 'online'
  return (
    <>
      <div className="prop-acts" data-small={small === true}>
        <button
          type="button"
          className="btn primary"
          data-act="start"
          disabled={off}
          onClick={() => act.accept()}
        >
          {t('proposal.start')}
        </button>
        <button
          type="button"
          className="btn"
          data-act="edit"
          // 弹窗要父会话的摘要（harness、项目、标题）
          disabled={off || !parent}
          onClick={() => setEditing(true)}
        >
          {t('proposal.edit')}
        </button>
        <button
          type="button"
          className="btn ghost"
          data-act="dismiss"
          disabled={off}
          onClick={() => act.dismiss()}
        >
          {t('proposal.dismiss')}
        </button>
      </div>
      {act.failure ? <p className="prop-err err">{act.failure}</p> : null}
      {editing && parent ? (
        <SpawnDialog
          deviceId={deviceId}
          parent={parent}
          proposal={proposal}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  )
}

/** 卡片上那一排小字：harness、模型、目录、全新还是带上下文 */
function ProposalMeta({
  deviceId,
  harness,
  model,
  cwd,
  kind,
}: {
  deviceId: string
  harness: string | null
  model: string | null
  cwd: string | null
  kind: SessionProposalView['kind']
}) {
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  return (
    <span className="prop-meta">
      {harness ? (
        <span className="chip" title={nameOf(device, harness)}>
          {badgeOf(device, harness)}
        </span>
      ) : null}
      {harness ? <span>{nameOf(device, harness)}</span> : null}
      {model ? <span className="mono">{model}</span> : null}
      {cwd ? (
        <span className="mono ell prop-cwd" title={cwd}>
          {cwd}
        </span>
      ) : null}
      <span className="pill mute">{t(kind === 'fork' ? 'proposal.fork' : 'proposal.fresh')}</span>
    </span>
  )
}

/** litch_sessions.start 降成提案的那一条 */
export function ProposalCard({
  deviceId,
  sessionId,
  itemId,
  item,
}: ItemRef & { item: ToolCallItem }) {
  const t = useT()
  const { open } = useActions()
  const spawned = item.spawned
  const proposalId = spawned?.proposalId ?? ''
  const list = useProposalList(deviceId, sessionId)
  const now = useProposalClock(list)
  const proposal = list?.find((entry) => entry.id === proposalId)
  const starts = useKey<ProposalStarts>(keys.proposalStarts(deviceId))
  const parent = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const childId = proposal?.startedId ?? starts?.[proposalId] ?? ''
  const child = useKey<SessionSummary>(keys.summary(deviceId, childId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const [unfolded, setUnfolded] = useState(false)
  if (!spawned) return null
  // 列表里没有这一张（对面没给、或者还没取到）：照调用时给的画，开始了的看侧栏
  const status = proposal
    ? proposalStatus(proposal, now)
    : childId
      ? 'started'
      : list === undefined
        ? null
        : 'unknown'
  const title = proposal?.title ?? spawned.title
  const prompt = proposal?.prompt ?? spawned.prompt
  const harness = proposal?.harness ?? spawned.harness ?? parent?.harness ?? null
  const long = prompt.length > LONG_BRIEF || prompt.split('\n').length > 3
  const pending = status === 'pending' && proposal !== undefined
  return (
    <div
      className="tree-card prop-card"
      data-card="proposal"
      data-proposal={proposalId}
      data-item={itemId}
      data-state={status ?? ''}
      data-anchor={`i:${itemId}`}
    >
      <div className="prop-body">
        <span className="tree-card-kind">
          <Icon name="suggest" small />
          <span className="grow">{t('proposal.kind')}</span>
          {status ? (
            <span className="prop-state">
              {t(status === 'unknown' ? 'proposal.state.unknown' : STATUS_TEXT[status])}
            </span>
          ) : null}
        </span>
        <b className="prop-title">{title}</b>
        <ProposalMeta
          deviceId={deviceId}
          harness={harness}
          model={proposal?.model ?? spawned.model}
          cwd={proposal?.cwd ?? spawned.cwd}
          kind={proposal?.kind ?? spawned.kind}
        />
        {prompt ? (
          <div className="prop-brief" data-open={unfolded || !long}>
            {prompt}
          </div>
        ) : null}
        {long ? (
          <button
            type="button"
            className="prop-more"
            aria-expanded={unfolded}
            onClick={() => setUnfolded(!unfolded)}
          >
            {t(unfolded ? 'proposal.brief.less' : 'proposal.brief.more')}
          </button>
        ) : null}
        {pending && proposal.widerSandbox ? (
          <p className="prop-wider" data-wider={proposal.widerSandbox}>
            {t('proposal.wider', { level: t(SANDBOX_LEVEL[proposal.widerSandbox]) })}
          </p>
        ) : null}
        {pending ? (
          <ProposalActs deviceId={deviceId} sessionId={sessionId} proposal={proposal} />
        ) : null}
      </div>
      {status === 'started' && childId ? (
        <button
          type="button"
          className="prop-child"
          data-child={childId}
          disabled={!child || !open}
          title={t('tree.child.open')}
          onClick={() => open?.({ deviceId, sessionId: childId })}
        >
          <i className={`st ${markOf(child?.status)}`} />
          <span className="ell grow">
            {child ? t.text(child.title) || title : t('tree.child.gone')}
          </span>
          {child ? (
            <span className="chip" title={nameOf(device, child.harness)}>
              {badgeOf(device, child.harness)}
            </span>
          ) : null}
          {child ? (
            <span className="tree-card-state">{t(`tree.status.${child.status}`)}</span>
          ) : null}
        </button>
      ) : null}
    </div>
  )
}
