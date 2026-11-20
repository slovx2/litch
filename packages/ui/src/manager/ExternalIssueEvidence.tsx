import type { ExternalIssueFields, ExternalIssueId, ExternalOutboxFilter } from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { ExternalLink, ExternalStatus } from '../devices/ExternalControls.tsx'
import { externalTime, useExternalTopic } from '../devices/external-view.ts'

export function ExternalIssueEvidence({
  issue,
  issueId,
  deviceId,
  managerId,
}: {
  issue: ExternalIssueFields
  issueId: ExternalIssueId
  deviceId: string
  managerId: string
}) {
  const t = useT()
  const refName = (url: string, number: string) =>
    /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\//u.exec(url)?.[1]
      ? `${/github\.com\/([^/]+\/[^/]+)\//u.exec(url)?.[1]}#${number}`
      : `#${number}`
  if (!issue.externalRefs?.length && !issue.intakeMandates?.length) return null
  return (
    <section className="external-panel external-stack" data-external-evidence={issueId}>
      {issue.externalRefs?.length ? (
        <div className="external-stack">
          <h3>{t('external.refs')}</h3>
          <ul className="external-list">
            {issue.externalRefs.map((ref) => (
              <li key={ref.url}>
                <ExternalLink url={ref.url}>{refName(ref.url, ref.number)}</ExternalLink>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {issue.intakeMandates?.length ? (
        <div className="external-stack">
          <h3>{t('external.mandates')}</h3>
          <ul className="external-list">
            {issue.intakeMandates.map((mandate) => (
              <li key={mandate.mandateId} className="external-wrap">
                <span>
                  {t('external.mandate.author', {
                    id: mandate.requesterUserId,
                    role: t(`external.role.${mandate.observedRole}`),
                  })}
                </span>
                <span className="dim">
                  {t('external.mandate.rule', {
                    rule: mandate.ruleId,
                    version: mandate.rulesVersion,
                    route: mandate.routeId,
                  })}
                  {' · '}
                  {externalTime(mandate.acceptedAt, t.lang)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ExternalWriteStatus deviceId={deviceId} filter={{ managerId, issueId }} />
    </section>
  )
}

export function ExternalWriteStatus({
  deviceId,
  filter,
}: {
  deviceId: string
  filter: ExternalOutboxFilter
}) {
  const t = useT()
  const { channel } = useServices()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const outbox = useExternalTopic({ kind: 'externalOutbox', deviceId, filter }, open)
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t('external.outbox')}</summary>
      {open ? (
        <div className="external-stack">
          <ExternalStatus view={outbox} />
          {outbox?.value?.entries.length ? (
            <ul className="external-list">
              {outbox.value.entries.map((entry) => (
                <li className="external-wrap" key={entry.operationId}>
                  <span>
                    {t(`external.action.${entry.action}`)} · {t(`external.outbox.${entry.state}`)}
                  </span>
                  {entry.receipt ? (
                    <ExternalLink url={entry.receipt.url}>
                      {t('external.replyReceipt')}
                    </ExternalLink>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : outbox?.value ? (
            <span className="dim">{t('external.inbox.empty')}</span>
          ) : null}
          {outbox?.online && outbox.value?.nextBeforeSeq != null ? (
            <button
              type="button"
              className="mini external-start"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                setError(undefined)
                void channel
                  .command('external.outbox.more', { deviceId, filter })
                  .catch(setError)
                  .finally(() => setBusy(false))
              }}
            >
              {t('external.more')}
            </button>
          ) : null}
          {error ? (
            <p className="err" role="alert">
              {whyNot(error, t)}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}
