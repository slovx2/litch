// X-n 原帖下方的一行 GitHub：外部引用（原帖链接），折叠的接单依据与回写记录。
// 只在设备给了 externalRefs / intakeMandates 时出现；回写记录展开时才订阅（按经理与 X-n 过滤）。
// 决策答复来自 GitHub 评论时，答复头上加“来自 GitHub 评论”的外链（AnswerSource）。
import type { ExternalAnswerSource } from '@litch/core'
import { useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { ExternalOutboxSummary } from '../../../protocol/src/external-sources.mts'
import type { ManagerIssue } from '../../../protocol/src/manager-issues.mts'
import { useT } from '../app/appearance.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { useExternalOutbox } from './data.ts'
import { subjectLabel } from './model.ts'
import { ExtLink } from './parts.tsx'

const WRITE_TONE: Record<ExternalOutboxSummary['state'], string> = {
  queued: 'pill mute',
  sending: 'pill wait',
  confirmed: 'pill ok',
  unknown: 'pill err',
  failed: 'pill err',
  blocked: 'pill err',
  canceled: 'pill mute',
}

function Writes({
  manager,
  issueId,
}: {
  manager: Pick<ManagerView, 'deviceId' | 'id'>
  issueId: string
}) {
  const t = useT()
  const view = useExternalOutbox(manager.deviceId, {
    managerId: manager.id,
    issueId: issueId as `X-${number}`,
  })
  const entries = view?.value?.entries ?? null
  if (entries === null) return <div className="ext-empty">{t('ext.loading')}</div>
  if (!entries.length) return <div className="ext-empty">{t('ext.refs.noWrites')}</div>
  return (
    <ul className="ext-diags">
      {entries.map((one) => (
        <li key={one.operationId} className="ext-diag" data-write={one.state}>
          <span>{t(`ext.action.${one.action}`)}</span>
          <span className={WRITE_TONE[one.state]}>{t(`ext.write.state.${one.state}`)}</span>
          {one.receipt ? <Stamp className="dim" at={one.receipt.at * 1000} /> : null}
          {one.errorClass ? <span className="dim mono">{one.errorClass}</span> : null}
          <span className="grow" />
          {one.receipt ? <ExtLink url={one.receipt.url} /> : null}
        </li>
      ))}
    </ul>
  )
}

export function IssueExternal({
  manager,
  issue,
}: {
  manager: Pick<ManagerView, 'deviceId' | 'id'>
  issue: ManagerIssue
}) {
  const t = useT()
  const [open, setOpen] = useState<'mandates' | 'writes' | null>(null)
  const refs = issue.externalRefs ?? []
  const mandates = issue.intakeMandates ?? []
  if (!refs.length && !mandates.length) return null
  const toggle = (key: 'mandates' | 'writes') => setOpen(open === key ? null : key)
  return (
    <div className="ext-refs" data-ext-refs={issue.id}>
      <div className="ext-row">
        <span className="ext-refs-label">GitHub</span>
        {refs.map((ref) => (
          <ExtLink key={`${ref.repoId}/${ref.number}`} url={ref.url}>
            <span className="mono">{subjectLabel(ref)}</span>
            {ref.kind === 'pull_request' ? ` · ${t('ext.kind.pull_request')}` : ''}
          </ExtLink>
        ))}
        <span className="grow" />
        {mandates.length ? (
          <button
            type="button"
            className="ext-chip"
            data-act="refs-mandates"
            aria-pressed={open === 'mandates'}
            onClick={() => toggle('mandates')}
          >
            {t('ext.refs.mandates')} {mandates.length}
          </button>
        ) : null}
        <button
          type="button"
          className="ext-chip"
          data-act="refs-writes"
          aria-pressed={open === 'writes'}
          onClick={() => toggle('writes')}
        >
          {t('ext.refs.writes')}
        </button>
      </div>
      {open === 'mandates' ? (
        <ul className="ext-diags" data-ext-mandates>
          {mandates.map((one) => (
            <li key={one.mandateId} className="ext-diag" data-mandate={one.mandateId}>
              <span>{t(one.decision === 'merge' ? 'ext.refs.merged' : 'ext.refs.accepted')}</span>
              <span className={one.observedRole === 'owner' ? 'pill ok' : 'pill mute'}>
                {one.observedRole === 'owner' ? t('ext.inbox.owner') : one.observedRole}
              </span>
              <span className="dim mono">#{one.requesterUserId}</span>
              <span className="dim">
                {t('ext.inbox.rule')} <span className="mono">{one.ruleId}</span> v{one.rulesVersion}
              </span>
              <Stamp className="dim" at={one.acceptedAt * 1000} />
              <span className="dim">
                {one.authorizedScope.actions.map((a) => t(`ext.action.${a}`)).join(' · ')}
              </span>
              {one.revokedAt ? <span className="pill err">{t('ext.refs.revoked')}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {open === 'writes' ? <Writes manager={manager} issueId={issue.id} /> : null}
    </div>
  )
}

export function AnswerSource({ source }: { source: ExternalAnswerSource }) {
  const t = useT()
  return (
    <span className="ext-answer-source" data-answer-source={source.commentId}>
      <ExtLink url={source.url} label={t('ext.answer.fromGithub')}>
        {t('ext.answer.fromGithub')} ↗
      </ExtLink>
    </span>
  )
}
