// 跨回合待答区。问题只在这里提供一次作答入口，历史中的调用保留答复记录。
import {
  type DeviceView,
  keys,
  type PendingQuestion,
  pendingReplyText,
  type SessionMeta,
} from '@litch/core'
import { useState } from 'react'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { useRunningSend } from './send-mode.ts'

export function PendingQuestions({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const questions = useKey<PendingQuestion[]>(keys.pendingQuestions(deviceId, sessionId)) ?? []
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const [expanded, setExpanded] = useState(true)
  if (questions.length === 0) return null
  return (
    <section className="pending-asks" aria-label={t('ask.pending')}>
      <button
        type="button"
        className="pending-asks-head"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <i className="st wait" />
        {t('ask.pendingCount', { count: questions.length })}
        <span>{expanded ? '⌄' : '›'}</span>
      </button>
      {expanded ? (
        <div className="pending-asks-body">
          {questions.map((question) => (
            <PendingCard
              key={question.id}
              question={question}
              deviceId={deviceId}
              sessionId={sessionId}
              enabled={meta?.live === true && device?.connection === 'online'}
              canSteer={meta?.can.steer}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function PendingCard({
  question,
  deviceId,
  sessionId,
  enabled,
  canSteer,
}: {
  question: PendingQuestion
  deviceId: string
  sessionId: string
  enabled: boolean
  canSteer: boolean | undefined
}) {
  const t = useT()
  const { channel } = useServices()
  const steer = useRunningSend(canSteer) === 'steer'
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const send = async (answer: string) => {
    if (!enabled || busy || !answer.trim()) return
    setBusy(true)
    setFailure(null)
    try {
      await channel.command('session.send', {
        deviceId,
        sessionId,
        text: pendingReplyText(question, answer.trim()),
        ...(question.kind === 'async' || steer ? { now: true } : {}),
      })
    } catch (error) {
      setFailure(whyNot(error, t))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="tail-ask" data-state="open" data-pending-question={question.id}>
      <div className="tail-ask-q">
        <span className="grow">{question.title}</span>
      </div>
      <div className="tail-ask-acts">
        {question.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            className={
              (question.kind === 'wrap' ? index === 0 : picked === option.answer)
                ? 'btn primary'
                : 'btn'
            }
            data-act={index}
            disabled={!enabled || busy}
            aria-pressed={question.kind === 'async' ? picked === option.answer : undefined}
            onClick={() =>
              question.kind === 'wrap' ? void send(option.answer) : setPicked(option.answer)
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      <form
        className="pending-asks-reply"
        onSubmit={(event) => {
          event.preventDefault()
          void send(text.trim() || picked || '')
        }}
      >
        <input
          className="req-input"
          aria-label={t('ask.reply')}
          placeholder={t('ask.other')}
          value={text}
          disabled={!enabled || busy}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          className="btn"
          type="submit"
          disabled={!enabled || busy || !(text.trim() || picked)}
        >
          {t('ask.send')}
        </button>
      </form>
      {failure ? <p className="tail-ask-hint err">{failure}</p> : null}
    </div>
  )
}
