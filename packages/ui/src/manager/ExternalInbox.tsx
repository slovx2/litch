import type {
  Commands,
  ExternalInboxEvent,
  ExternalInboxFilter,
  ExternalIssueId,
  ExternalTriageAction,
  ManagerView,
} from '@litch/core'
import { useRef, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { Icon } from '../app/icons.tsx'
import { useServices } from '../app/services.tsx'
import { ExternalDialog, ExternalLink, ExternalStatus } from '../devices/ExternalControls.tsx'
import { externalOperationId, externalTime, useExternalTopic } from '../devices/external-view.ts'
import { useManagers } from './data.ts'
import { ExternalWriteStatus } from './ExternalIssueEvidence.tsx'

const tabs = ['pending', 'processed', 'blocked'] as const
type Tab = (typeof tabs)[number]
const actions = ['accept', 'merge', 'ignore', 'reassign'] as const
type Intake = NonNullable<Commands['external.inbox.get']['result']['intake']>

export function ExternalInbox({
  manager,
  disabled,
  onOpenIssue,
}: {
  manager: ManagerView
  disabled: boolean
  onOpenIssue(id: ExternalIssueId): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [tab, setTab] = useState<Tab>('pending')
  const [notified, setNotified] = useState(false)
  const [reasonInput, setReasonInput] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [replyNotice, setReplyNotice] = useState('')
  const [editing, setEditing] = useState<{ event: ExternalInboxEvent; intake: Intake }>()
  const filter: ExternalInboxFilter = {
    managerId: manager.id,
    ...(tab === 'pending'
      ? { status: 'pending_triage', ...(reason ? { reason } : {}) }
      : tab === 'blocked'
        ? { status: 'blocked' }
        : { statuses: notified ? ['notified'] : ['processed', 'notified'] }),
  }
  const view = useExternalTopic({ kind: 'externalInbox', deviceId: manager.deviceId, filter })
  const entries = view?.value?.entries ?? []
  const work = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
    }
  }
  const start = (event: ExternalInboxEvent) =>
    work(async () => {
      if (!event.intakeId) return
      const { intake } = await channel.command('external.inbox.get', {
        deviceId: manager.deviceId,
        intakeId: event.intakeId,
      })
      if (intake?.status !== 'pending_triage') {
        setReplyNotice(t('external.inbox.noIntake'))
        return
      }
      setReplyNotice('')
      setEditing({ event, intake })
    })

  return (
    <section className="external-stack" data-external-inbox>
      <div className="seg external-segments">
        {tabs.map((key) => (
          <button
            type="button"
            key={key}
            aria-pressed={key === tab}
            onClick={() => {
              setTab(key)
              setReplyNotice('')
              setError(undefined)
            }}
          >
            {t(`external.inbox.${key}`)}
          </button>
        ))}
      </div>
      {tab === 'pending' ? (
        <form
          className="external-row"
          onSubmit={(event) => {
            event.preventDefault()
            setReason(reasonInput.trim())
          }}
        >
          <input
            aria-label={t('external.inbox.reason')}
            placeholder={t('external.inbox.reason')}
            value={reasonInput}
            onChange={(event) => {
              setReasonInput(event.target.value)
              if (!event.target.value) setReason('')
            }}
          />
          <button type="submit" className="ibtn" aria-label={t('external.inbox.reason')}>
            <Icon name="filter" small />
          </button>
        </form>
      ) : tab === 'processed' ? (
        <label className="external-choice">
          <input
            type="checkbox"
            checked={notified}
            onChange={(event) => setNotified(event.target.checked)}
          />
          {t('external.inbox.notified')}
        </label>
      ) : null}
      <ExternalStatus view={view} />
      {view?.value && !entries.length ? (
        <p className="external-note">{t('external.inbox.empty')}</p>
      ) : null}
      {replyNotice ? <p role="status">{replyNotice}</p> : null}
      <ul className="external-list">
        {entries.map((event) => {
          const repo =
            /^https:\/\/github\.com\/([^/]+\/[^/]+)\//u.exec(event.subject.url)?.[1] ??
            event.subject.repoId
          return (
            <li className="external-stack" key={event.eventKey}>
              <div className="external-row">
                <b className="grow">
                  <ExternalLink url={event.subject.url}>
                    {repo}#{event.subject.number}
                  </ExternalLink>
                </b>
                {event.issueId ? (
                  <button
                    type="button"
                    className="mini"
                    onClick={() => event.issueId && onOpenIssue(event.issueId)}
                  >
                    {event.issueId}
                  </button>
                ) : null}
                {event.intakeId && tab === 'pending' ? (
                  <button
                    type="button"
                    className="mini external-button"
                    disabled={busy || disabled || !view?.online}
                    title={disabled || !view?.online ? t('issue.offline') : undefined}
                    onClick={() => void start(event)}
                  >
                    <Icon name="tool" small />
                    {t('external.inbox.triage')}
                  </button>
                ) : null}
              </div>
              <div className="external-wrap external-note">
                <ExternalLink url={event.eventUrl}>{event.kind}</ExternalLink>
                <span>{externalTime(event.occurredAt, t.lang)}</span>
                {event.actorId ? (
                  <span>
                    {t('external.inbox.actor', {
                      id: event.actorId,
                      role: event.actorRoleAtCheck
                        ? t(`external.role.${event.actorRoleAtCheck}`)
                        : t('external.inbox.unknown'),
                    })}
                  </span>
                ) : null}
                {event.ruleId ? (
                  <span>
                    {t('external.inbox.rule', {
                      rule: event.ruleId,
                      version: event.rulesVersion ?? '–',
                    })}
                  </span>
                ) : null}
                {event.reason ? <span className="pill mute">{event.reason}</span> : null}
                {event.delivery ? (
                  <span
                    className={event.delivery.state === 'confirmed' ? 'pill ok' : 'pill mute'}
                    title={event.delivery.reason}
                  >
                    {t(`external.inbox.delivery.${event.delivery.state}`)}
                  </span>
                ) : event.status === 'notified' ? (
                  <span className="pill ok">{t('external.inbox.notifiedState')}</span>
                ) : null}
              </div>
              {event.issueId ? (
                <ExternalWriteStatus
                  deviceId={manager.deviceId}
                  filter={{ managerId: manager.id, issueId: event.issueId }}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      {view?.online && view.value?.nextBeforeSeq != null ? (
        <button
          type="button"
          className="mini external-start"
          disabled={busy}
          onClick={() =>
            void work(() =>
              channel.command('external.inbox.more', { deviceId: manager.deviceId, filter }),
            )
          }
        >
          {t('external.more')}
        </button>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {whyNot(error, t)}
        </p>
      ) : null}
      {editing ? (
        <TriageForm
          key={editing.intake.intakeId}
          {...editing}
          manager={manager}
          disabled={disabled || !view?.online}
          close={() => setEditing(undefined)}
          saved={(reply) => {
            setEditing(undefined)
            if (reply && 'notQueued' in reply)
              setReplyNotice(t('external.inbox.replyNotQueued', { reason: reply.notQueued }))
          }}
        />
      ) : null}
    </section>
  )
}

function TriageForm({
  event,
  intake,
  manager,
  disabled,
  close,
  saved,
}: {
  event: ExternalInboxEvent
  intake: Intake
  manager: ManagerView
  disabled: boolean
  close(): void
  saved(reply?: { operationId: string } | { notQueued: string }): void
}) {
  const { channel } = useServices()
  const t = useT()
  const { managers } = useManagers()
  const destinations = managers.filter(
    (row) => row.deviceId === manager.deviceId && row.id !== manager.id && row.status === 'active',
  )
  const [action, setAction] = useState<ExternalTriageAction['action']>('accept')
  const retry = useRef<{ payload: string; key: string } | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [reply, setReply] = useState('')
  const [other, setOther] = useState('')
  const [ignore, setIgnore] = useState('')
  const [destination, setDestination] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const validIssue = /^X-[1-9]\d*$/u.test(other.trim())
  const ready =
    action === 'accept'
      ? title.trim()
      : action === 'merge'
        ? validIssue
        : action === 'ignore'
          ? ignore.trim()
          : destination
  const submit = async () => {
    if (disabled || busy || !ready) return
    setBusy(true)
    setFailure('')
    try {
      const notes = reply.trim() ? { reply: reply.trim() } : {}
      let proposal: ExternalTriageAction
      if (action === 'accept') proposal = { action, title: title.trim(), body, ...notes }
      else if (action === 'ignore') proposal = { action, reason: ignore.trim(), ...notes }
      else if (action === 'reassign') proposal = { action, managerId: destination }
      else {
        const issueId = other.trim() as ExternalIssueId
        const { issue } = await channel.command('managers.issue.read', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          id: issueId,
        })
        proposal = { action, issueId, expectedIssueRevision: issue.revision, ...notes }
      }
      const payload = JSON.stringify(proposal)
      const key = retry.current?.payload === payload ? retry.current.key : externalOperationId()
      retry.current = { payload, key }
      const result = await channel.command('external.inbox.triage', {
        ...proposal,
        deviceId: manager.deviceId,
        intakeId: intake.intakeId,
        expectedRevision: intake.revision,
        idempotencyKey: key,
      })
      if (result.outcome === 'conflict') setFailure(t('external.inbox.conflict'))
      else saved(result.reply)
    } catch (cause) {
      setFailure(whyNot(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ExternalDialog
      label={t('external.inbox.triage')}
      close={() => {
        if (!busy) close()
      }}
    >
      <form
        className="external-stack"
        onSubmit={(form) => {
          form.preventDefault()
          void submit()
        }}
      >
        <ExternalLink url={event.eventUrl}>
          {t('external.inbox.openEvent')} · #{event.subject.number}
        </ExternalLink>
        <fieldset className="external-bare external-stack" disabled={disabled || busy}>
          <div className="seg external-segments">
            {actions.map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={key === action}
                onClick={() => setAction(key)}
                disabled={key === 'reassign' && !destinations.length}
                title={
                  key === 'reassign' && !destinations.length
                    ? t('external.previewNoTarget')
                    : undefined
                }
              >
                {t(`external.inbox.${key}`)}
              </button>
            ))}
          </div>
          {action === 'accept' ? (
            <>
              <label className="external-field">
                {t('external.inbox.title')}
                <input maxLength={256} value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="external-field">
                {t('external.inbox.body')}
                <textarea
                  rows={4}
                  value={body}
                  maxLength={65536}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
            </>
          ) : action === 'ignore' ? (
            <label className="external-field">
              {t('external.inbox.ignoreReason')}
              <input value={ignore} maxLength={256} onChange={(e) => setIgnore(e.target.value)} />
            </label>
          ) : action === 'merge' ? (
            <label className="external-field">
              {t('external.inbox.issue')}
              <input value={other} placeholder="X-1" onChange={(e) => setOther(e.target.value)} />
            </label>
          ) : (
            <label className="external-field">
              {t('external.routeManager')}
              <select value={destination} onChange={(e) => setDestination(e.target.value)}>
                <option value="">{t('external.routeManagerEmpty')}</option>
                {destinations.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name || row.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {action !== 'reassign' ? (
            <label className="external-field">
              {t('external.inbox.reply')}
              <textarea
                value={reply}
                maxLength={65536}
                onChange={(e) => setReply(e.target.value)}
              />
            </label>
          ) : null}
        </fieldset>
        {failure ? (
          <p className="err" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="external-actions">
          <button type="button" className="btn ghost" onClick={close} disabled={busy}>
            {t('external.cancel')}
          </button>
          <button type="submit" className="btn" disabled={!ready || disabled || busy}>
            {t(`external.inbox.${action}`)}
          </button>
        </div>
      </form>
    </ExternalDialog>
  )
}
