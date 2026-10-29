import { useState } from 'react'
import type {
  ManagerDecisionView,
  ManagerSubmittedAnswer,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { type AnswerDrafts, answeredDrafts, useAnswerDrafts } from './drafts.ts'

export function Decisions({
  manager,
  decisions,
  disabled,
  visible,
}: {
  manager: ManagerView
  decisions: ManagerDecisionView[]
  disabled: boolean
  visible: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const { drafts, write } = useAnswerDrafts(manager.deviceId, manager.id)
  const [filter, setFilter] = useState<'open' | 'answered' | 'closed'>('open')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const answers = answeredDrafts(drafts)
  const conflict = answers.some(
    (draft) =>
      !decisions.some(
        (decision) =>
          decision.id === draft.decisionId &&
          decision.status === 'open' &&
          decision.revision === draft.revision,
      ),
  )
  const save = (next: AnswerDrafts) => {
    try {
      write(next)
      setError('')
    } catch {
      setError(t('manager.savedFail'))
    }
  }
  const change = (decision: ManagerDecisionView, patch: Partial<ManagerSubmittedAnswer>) => {
    save({
      ...drafts,
      [decision.id]: {
        decisionId: decision.id,
        revision: decision.revision,
        optionId: null,
        text: '',
        ...drafts[decision.id],
        ...patch,
      },
    })
  }
  const request = async (text: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await channel.command('session.send', {
        deviceId: manager.deviceId,
        sessionId: manager.threadId,
        text,
        now: true,
      })
      setNotice(t('manager.requested'))
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const submit = async () => {
    if (busy || disabled || conflict || !answers.length) return
    setBusy(true)
    setError('')
    try {
      const result = await channel.command('managers.answers.submit', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        answers,
      })
      const next = { ...drafts }
      for (const decision of result.accepted) delete next[decision.id]
      save(next)
      if (result.rejected.length)
        setError(
          t('manager.rejected', {
            reason: result.rejected
              .map((entry) => `${entry.decisionId}: ${entry.message}`)
              .join(' · '),
          }),
        )
      else setFilter('answered')
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const reopen = async (decision: ManagerDecisionView) => {
    setBusy(true)
    setError('')
    try {
      await channel.command('managers.decision.reopen', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        decisionId: decision.id,
      })
      setFilter('open')
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const grouped = {
    open: decisions.filter((decision) => decision.status === 'open'),
    answered: decisions.filter((decision) => decision.status === 'answered'),
    closed: decisions.filter(
      (decision) => decision.status === 'expired' || decision.status === 'withdrawn',
    ),
  }
  return (
    <>
      <div hidden={!visible}>
        <div className="mg-decision-filter seg">
          {(['open', 'answered', 'closed'] as const).map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(`manager.${key}`)} {grouped[key].length}
            </button>
          ))}
        </div>
        <div className="mg-stack">
          {grouped[filter].length === 0 ? <p className="mg-empty">{t('manager.none')}</p> : null}
          {grouped[filter].map((decision) => {
            const draft = drafts[decision.id]
            const stale = draft && draft.revision !== decision.revision
            return (
              <article
                className="mg-decision"
                data-decision={decision.id}
                key={decision.id}
                data-draft={Boolean(draft)}
              >
                <header>
                  <span className="mono dim">{decision.id}</span>
                  <h3>{decision.title}</h3>
                  {draft ? <span className="pill wait">{t('manager.draft')}</span> : null}
                </header>
                <p>{decision.background}</p>
                {decision.blocks.length ? (
                  <p className="dim">
                    {t('manager.blocked')} · {decision.blocks.join(', ')}
                  </p>
                ) : null}
                {decision.status === 'open' ? (
                  <>
                    {stale ? (
                      <div className="mg-conflict" role="alert">
                        <p>{t('manager.conflict')}</p>
                        <button
                          type="button"
                          className="btn"
                          disabled={disabled || busy}
                          onClick={() =>
                            change(decision, {
                              revision: decision.revision,
                              optionId: decision.options.some(
                                (option) => option.id === draft.optionId,
                              )
                                ? draft.optionId
                                : null,
                            })
                          }
                        >
                          {t('manager.confirm')}
                        </button>
                      </div>
                    ) : null}
                    <fieldset
                      className="mg-options"
                      disabled={disabled || busy}
                      aria-label={decision.title}
                    >
                      {decision.options.map((option) => (
                        <label
                          key={option.id}
                          className="mg-option"
                          data-selected={draft?.optionId === option.id}
                        >
                          <input
                            type="radio"
                            name={`manager-${manager.id}-${decision.id}`}
                            checked={draft?.optionId === option.id}
                            onChange={() => change(decision, { optionId: option.id })}
                          />
                          <span className="grow">
                            <b>{option.label}</b>
                            {option.description ? <small>{option.description}</small> : null}
                          </span>
                          {decision.recommend === option.id ? (
                            <span className="mg-recommend">{t('manager.recommend')}</span>
                          ) : null}
                        </label>
                      ))}
                      {draft?.optionId ? (
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => change(decision, { optionId: null })}
                        >
                          {t('manager.clearOption')}
                        </button>
                      ) : null}
                    </fieldset>
                    <textarea
                      className="req-input"
                      rows={2}
                      aria-label={t('manager.answer')}
                      placeholder={t('manager.answer')}
                      disabled={disabled || busy}
                      value={draft?.text ?? ''}
                      onChange={(event) => change(decision, { text: event.target.value })}
                    />
                    <div className="mg-actions">
                      {decision.recommend ? (
                        <button
                          type="button"
                          className="btn"
                          data-act="manager-recommend"
                          disabled={disabled || busy}
                          onClick={() => change(decision, { optionId: decision.recommend })}
                        >
                          {t('manager.useRecommend')}
                        </button>
                      ) : null}
                      <span className="grow" />
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={disabled || busy}
                        onClick={() => void request(t('manager.deferRequest', { id: decision.id }))}
                      >
                        {t('manager.defer')}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    {decision.answer ? (
                      <p>
                        {
                          decision.options.find((option) => option.id === decision.answer?.optionId)
                            ?.label
                        }{' '}
                        {decision.answer.text}
                        <small className="dim">
                          {' '}
                          · {new Date(decision.answer.at).toLocaleString()}
                        </small>
                      </p>
                    ) : null}
                    {decision.closed ? <p>{decision.closed.reason}</p> : null}
                    {decision.landed.length ? (
                      <p className="dim">
                        {t('manager.landed')}{' '}
                        {decision.landed.map((link) => link.label ?? link.target).join(' · ')}
                      </p>
                    ) : null}
                    {decision.status !== 'answered' ? (
                      <button
                        type="button"
                        className="btn ghost"
                        disabled={disabled || busy}
                        onClick={() => void reopen(decision)}
                      >
                        {t('manager.reopen')}
                      </button>
                    ) : null}
                  </>
                )}
                <footer className="mg-basis">
                  <span>
                    {t('manager.basis')}{' '}
                    {decision.basis.map((link) => link.label ?? link.target).join(' · ') || '—'}
                  </span>
                  {decision.checked ? (
                    <span>
                      {decision.checked.commit?.slice(0, 8)} ·{' '}
                      {t('manager.checked', {
                        time: new Date(decision.checked.at).toLocaleString(),
                      })}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={disabled || busy}
                    onClick={() => void request(t('manager.verifyRequest', { id: decision.id }))}
                  >
                    {t('manager.verify')}
                  </button>
                </footer>
              </article>
            )
          })}
        </div>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {answers.length ? (
        <footer className="mg-send">
          <span className="grow">{t('manager.unsent', { n: answers.length })}</span>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => save({})}>
            {t('manager.clear')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-act="manager-submit"
            disabled={disabled || busy || conflict}
            title={
              conflict
                ? t('manager.conflict')
                : disabled
                  ? t(manager.status === 'ended' ? 'manager.readOnly' : 'manager.offline')
                  : undefined
            }
            onClick={() => void submit()}
          >
            {t(busy ? 'manager.submitting' : 'manager.submit')}
          </button>
        </footer>
      ) : null}
    </>
  )
}
