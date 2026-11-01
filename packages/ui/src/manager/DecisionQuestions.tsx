import { type DeviceView, keys } from '@litch/core'
import { useState } from 'react'
import type { ManagerDecisionView, ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'

export function DecisionQuestions({
  manager,
  decision,
  disabled,
  question,
  onQuestion,
}: {
  manager: ManagerView
  decision: ManagerDecisionView
  disabled: boolean
  question: string
  onQuestion(question: string): void
}) {
  const t = useT()
  const { channel } = useServices()
  const [mode, setMode] = useState<'manager' | 'temporary'>('manager')
  const [temporary, setTemporary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const discussion = decision.discussion
  const running = discussion?.messages.some((entry) => entry.status === 'running') === true
  const locked = disabled || busy || (mode === 'temporary' && running)
  const device = useKey<DeviceView>(keys.device(manager.deviceId))
  const canTemporary =
    device?.harnesses.find((harness) => harness.id === manager.harness)?.abilities
      ?.managerQuestions === true
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
          question: temporary.trim(),
        })
        setTemporary('')
      }
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mg-questions">
      <fieldset className="mg-question-modes" aria-label={t('manager.questionMode')}>
        <button
          type="button"
          aria-pressed={mode === 'manager'}
          data-question-mode="manager"
          onClick={() => setMode('manager')}
        >
          {t('manager.questionManager')}
        </button>
        {canTemporary ? (
          <button
            type="button"
            aria-pressed={mode === 'temporary'}
            data-question-mode="temporary"
            onClick={() => setMode('temporary')}
          >
            {t('manager.questionTemporary')}
          </button>
        ) : null}
      </fieldset>
      <div className="mg-question-body">
        <p className="dim">
          {t(mode === 'manager' ? 'manager.questionDraftNote' : 'manager.questionNote')}
        </p>
        {mode === 'temporary' && discussion?.light ? (
          <p className="dim">{t('manager.questionLight')}</p>
        ) : null}
        <div className="mg-question-log" aria-live="polite">
          {discussion?.messages.map((entry) => (
            <div className="mg-question-round" key={entry.id}>
              {entry.refreshed ? <p className="dim">{t('manager.questionRefreshed')}</p> : null}
              <p>
                <b>{t('manager.questionYou')}</b> {entry.question}
              </p>
              <div className={entry.status === 'failed' ? 'err' : undefined}>
                <b>
                  {t(
                    entry.mode === 'manager'
                      ? 'manager.questionManagerSpeaker'
                      : 'manager.questionTemporarySpeaker',
                  )}
                </b>
                {entry.status === 'running' ? (
                  t(
                    entry.mode === 'manager'
                      ? 'manager.questionPending'
                      : 'manager.questionRunning',
                  )
                ) : (
                  <BoardMarkdown text={entry.answer || t('manager.questionFailed')} />
                )}
              </div>
            </div>
          ))}
        </div>
        <textarea
          className="req-input"
          rows={2}
          value={mode === 'manager' ? question : temporary}
          maxLength={20000}
          disabled={locked}
          aria-label={t('manager.questionInput')}
          placeholder={t('manager.questionInput')}
          data-act="manager-question-input"
          onChange={(event) =>
            mode === 'manager' ? onQuestion(event.target.value) : setTemporary(event.target.value)
          }
        />
        {mode === 'temporary' ? (
          <div className="mg-actions">
            <button
              type="button"
              className="btn"
              data-act="manager-question-send"
              disabled={locked || !temporary.trim()}
              title={running ? t('manager.questionWait') : undefined}
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
        ) : null}
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  )
}
