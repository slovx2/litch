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
import { Caret } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import { useQuestionAge } from './question-age.ts'
import { useRunningSend } from './send-mode.ts'

export function PendingQuestions({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const t = useT()
  const questions = useKey<PendingQuestion[]>(keys.pendingQuestions(deviceId, sessionId)) ?? []
  const meta = useKey<SessionMeta>(keys.session(deviceId, sessionId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const [expanded, setExpanded] = useState(true)
  if (questions.length === 0) return null
  // 和审批卡同一个位置、同一种卡片：和输入区一样宽，题多了在卡片里面滚，收起时只剩标题一行
  return (
    <div className="req-slot">
      <section className="pending-asks" aria-label={t('ask.pending')}>
        <button
          type="button"
          className="pending-asks-head"
          aria-expanded={expanded}
          aria-controls={expanded ? `pending-${sessionId}` : undefined}
          onClick={() => setExpanded(!expanded)}
        >
          <i className="st wait" />
          <span className="grow">{t('ask.pendingCount', { count: questions.length })}</span>
          <Caret />
        </button>
        {expanded ? (
          <div className="pending-asks-body" id={`pending-${sessionId}`}>
            {questions.map((question) => (
              <PendingCard
                key={question.id}
                question={question}
                deviceId={deviceId}
                sessionId={sessionId}
                enabled={meta?.live === true && device?.connection === 'online'}
                canSteer={meta?.can.steer}
                canIgnore={device?.ignoreQuestions === true}
              />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}

function PendingCard({
  question,
  deviceId,
  sessionId,
  enabled,
  canSteer,
  canIgnore,
}: {
  question: PendingQuestion
  deviceId: string
  sessionId: string
  enabled: boolean
  canSteer: boolean | undefined
  canIgnore: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const age = useQuestionAge(question.proposedAt)
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
  const ignore = async () => {
    if (!canIgnore || !enabled || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await channel.command('session.questions.ignore', {
        deviceId,
        sessionId,
        sourceIds: question.sourceIds,
      })
    } catch (error) {
      setFailure(whyNot(error, t))
    } finally {
      setBusy(false)
    }
  }
  // 一道题两行：题目，下面是建议的回答和自己写的一栏排在同一行，窄了再折行
  return (
    <div className="pending-ask" data-state="open" data-pending-question={question.id}>
      <div className="pending-ask-q">{question.title}</div>
      <div className="pending-ask-meta">
        <span className="grow">
          {t(age.key, { count: age.count })}
          {question.reportsAfter > 0
            ? ` · ${t('ask.reportsAfter', { count: question.reportsAfter })}`
            : ''}
        </span>
        {canIgnore ? (
          <button
            type="button"
            className="mini"
            disabled={!enabled || busy}
            onClick={() => void ignore()}
          >
            {t('ask.ignore')}
          </button>
        ) : null}
      </div>
      <form
        className="pending-ask-row"
        onSubmit={(event) => {
          event.preventDefault()
          void send(text.trim() || picked || '')
        }}
      >
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
        <textarea
          rows={1}
          className="req-input"
          aria-label={t('ask.reply')}
          placeholder={t('ask.other')}
          value={text}
          disabled={!enabled || busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return
            event.preventDefault()
            void send(text.trim() || picked || '')
          }}
        />
        <button
          className="btn"
          type="submit"
          disabled={!enabled || busy || !(text.trim() || picked)}
        >
          {t('ask.send')}
        </button>
      </form>
      {failure ? <p className="pending-ask-err">{failure}</p> : null}
    </div>
  )
}
