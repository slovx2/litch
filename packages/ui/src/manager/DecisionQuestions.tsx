import { useState } from 'react'
import type { ManagerDecisionView, ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'

export function DecisionQuestions({
  manager,
  decision,
  disabled,
}: {
  manager: ManagerView
  decision: ManagerDecisionView
  disabled: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const discussion = decision.discussion
  const running = discussion?.messages.some((entry) => entry.status === 'running') === true
  const locked = disabled || running || busy
  const params = { deviceId: manager.deviceId, managerId: manager.id, decisionId: decision.id }
  const send = async (forward: boolean) => {
    if (locked) return
    setBusy(true)
    setError('')
    try {
      if (forward) await channel.command('managers.question.forward', params)
      else {
        await channel.command('managers.question.ask', {
          ...params,
          revision: decision.revision,
          question: question.trim(),
        })
        setQuestion('')
      }
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mg-questions">
      <button
        type="button"
        className="btn ghost"
        aria-expanded={open}
        data-act="manager-question-toggle"
        onClick={() => setOpen(!open)}
      >
        {t('manager.questionBackground')}
        {discussion?.messages.length ? ` · ${discussion.messages.length}` : ''}
      </button>
      {open ? (
        <div className="mg-question-body">
          <p className="dim">{t('manager.questionNote')}</p>
          {discussion?.light ? <p className="dim">{t('manager.questionLight')}</p> : null}
          <div className="mg-question-log" aria-live="polite">
            {discussion?.messages.map((entry) => (
              <div className="mg-question-round" key={entry.id}>
                {entry.refreshed ? <p className="dim">{t('manager.questionRefreshed')}</p> : null}
                <p>
                  <b>{t('manager.questionYou')}</b> {entry.question}
                </p>
                <p className={entry.status === 'failed' ? 'err' : undefined}>
                  {entry.status === 'running'
                    ? t('manager.questionRunning')
                    : entry.answer || t('manager.questionFailed')}
                </p>
              </div>
            ))}
          </div>
          <textarea
            className="req-input"
            rows={2}
            value={question}
            maxLength={20000}
            disabled={locked}
            aria-label={t('manager.questionInput')}
            placeholder={t('manager.questionInput')}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <div className="mg-actions">
            <button
              type="button"
              className="btn"
              data-act="manager-question-send"
              disabled={locked || !question.trim()}
              onClick={() => void send(false)}
            >
              {t('manager.questionSend')}
            </button>
            <button
              type="button"
              className="btn ghost"
              data-act="manager-question-forward"
              disabled={
                locked ||
                !discussion?.messages.length ||
                discussion.forwarded === discussion.messages.length
              }
              onClick={() => void send(true)}
            >
              {t(
                discussion?.forwarded === discussion?.messages.length && discussion?.messages.length
                  ? 'manager.questionForwarded'
                  : 'manager.questionForward',
              )}
            </button>
          </div>
          {error ? (
            <p className="err" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
