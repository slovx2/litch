import type { ManagerBoardPages } from '@litch/core'
import { useLayoutEffect, useRef, useState } from 'react'
import type {
  ManagerDecisionId,
  ManagerDecisionView,
  ManagerRequestView,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { BoardLinks } from './BoardLinks.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { BoardReferences } from './BoardReferences.tsx'
import { DecisionQuestions } from './DecisionQuestions.tsx'
import {
  type AnswerDrafts,
  answeredDrafts,
  cancelAnswerEdit,
  type DecisionDraft,
  questionDrafts,
  useAnswerDrafts,
} from './drafts.ts'
import { submittedRequests, useRequestDrafts } from './request-drafts.ts'

export function Decisions({
  manager,
  onBusy,
  decisions,
  requests,
  groups,
  disabled,
  visible,
  target,
  onLocated,
}: {
  manager: ManagerView
  onBusy(value: boolean): void
  decisions: ManagerDecisionView[]
  requests: ManagerRequestView[]
  groups: ManagerBoardPages['decisions']
  disabled: boolean
  visible: boolean
  target: { id: ManagerDecisionId } | null
  onLocated(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const { drafts, write } = useAnswerDrafts(manager.deviceId, manager.id)
  const { drafts: requestDrafts, write: writeRequests } = useRequestDrafts(
    manager.deviceId,
    manager.id,
  )
  const requestReplies = submittedRequests(requestDrafts)
  const [filter, setFilter] = useState<'open' | 'answered' | 'closed'>('open')
  const [tabs, setTabs] = useState<Record<string, 'answer' | 'question'>>({})
  const [editing, setEditing] = useState<Set<string>>(new Set())
  const cards = useRef<HTMLDivElement>(null)
  const targetDecision = target
    ? decisions.find((decision) => decision.id === target.id)
    : undefined
  const targetGroup =
    targetDecision?.status === 'open'
      ? 'open'
      : targetDecision?.status === 'answered'
        ? 'answered'
        : 'closed'
  useLayoutEffect(() => {
    if (target) setFilter(targetGroup)
  }, [target, targetGroup])
  useLayoutEffect(() => {
    if (!target || !visible || filter !== targetGroup) return
    const card = cards.current?.querySelector<HTMLElement>(`[data-decision="${target.id}"]`)
    if (!card) return
    card.scrollIntoView({ block: 'start' })
    card.focus({ preventScroll: true })
    onLocated()
  }, [target, targetGroup, filter, visible, onLocated])
  const [busy, setBusyState] = useState(false)
  const setBusy = (value: boolean) => {
    setBusyState(value)
    onBusy(value)
  }
  const [error, setError] = useState('')
  const answers = answeredDrafts(drafts)
  const questions = questionDrafts(drafts)
  const pending = [...answers, ...questions]
  const asking = pending.some((answer) =>
    decisions
      .find((decision) => decision.id === answer.decisionId)
      ?.discussion?.messages.some(
        (entry) => entry.status === 'running' && entry.mode !== 'manager',
      ),
  )
  const requestConflict = requestReplies.some(
    (draft) =>
      !requests.some(
        (request) =>
          request.id === draft.requestId &&
          request.revision === draft.revision &&
          request.status !== 'cancelled',
      ),
  )
  const conflict =
    requestConflict ||
    pending.some(
      (draft) =>
        !decisions.some(
          (decision) => decision.id === draft.decisionId && decision.revision === draft.revision,
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
  const change = (decision: ManagerDecisionView, patch: Partial<DecisionDraft>) => {
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
  const submit = async () => {
    if (busy || disabled || conflict || asking || (!pending.length && !requestReplies.length))
      return
    setBusy(true)
    setError('')
    try {
      const result = await channel.command('managers.feedback.submit', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        answers,
        questions,
        requests: requestReplies,
      })
      const next = { ...drafts }
      for (const decision of result.accepted) {
        const draft = next[decision.id]
        if (draft) next[decision.id] = { ...draft, optionId: null, text: '' }
      }
      for (const decision of result.acceptedQuestions) {
        const draft = next[decision.id]
        if (draft) next[decision.id] = { ...draft, question: '' }
      }
      for (const [id, draft] of Object.entries(next))
        if (!draft.text.trim() && draft.optionId === null && !draft.question?.trim())
          delete next[id]
      save(next)
      const nextRequests = { ...requestDrafts }
      for (const request of result.acceptedRequests) delete nextRequests[request.id]
      writeRequests(nextRequests)
      const rejected = [...result.rejected, ...result.rejectedQuestions]
      if (rejected.length || result.rejectedRequests.length)
        setError(
          t('manager.rejected', {
            reason: [
              ...rejected.map((entry) => `${entry.decisionId}: ${entry.message}`),
              ...result.rejectedRequests.map((entry) => `${entry.requestId}: ${entry.message}`),
            ].join(' · '),
          }),
        )
      else if (answers.length && !questions.length) setFilter('answered')
      setEditing(new Set())
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
  const grouped = { open: groups.pending, answered: groups.answered, closed: groups.closed }
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
        <div className="mg-stack" ref={cards}>
          {grouped[filter].length === 0 ? <p className="mg-empty">{t('manager.none')}</p> : null}
          {grouped[filter].map((decision) => {
            const draft = drafts[decision.id]
            const selectedTab = tabs[decision.id] ?? 'answer'
            const tabId = `manager-response-${manager.id}-${decision.id}`
            const stale = draft && draft.revision !== decision.revision
            return (
              <article
                className="mg-decision"
                data-decision={decision.id}
                key={decision.id}
                data-draft={Boolean(draft)}
                tabIndex={-1}
              >
                <header>
                  <span className="mono dim">{decision.id}</span>
                  <h3>{decision.title}</h3>
                  {draft ? <span className="pill wait">{t('manager.draft')}</span> : null}
                </header>
                <BoardMarkdown text={decision.background} />
                {decision.blocks.length ? (
                  <div className="mg-item-meta mg-decision-meta">
                    <div className="mg-item-meta-row">
                      <span className="mg-meta-label">{t('manager.blocked')}</span>
                      <div className="mg-item-waits">
                        {decision.blocks.map((id) => (
                          <BoardReferences key={id} text={id} />
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div
                  className="seg mg-response-tabs"
                  role="tablist"
                  aria-label={t('manager.responseTabs')}
                >
                  {(['answer', 'question'] as const).map((tab) => (
                    <button
                      type="button"
                      role="tab"
                      key={tab}
                      id={`${tabId}-${tab}`}
                      aria-selected={selectedTab === tab}
                      aria-controls={`${tabId}-${tab}-panel`}
                      tabIndex={selectedTab === tab ? 0 : -1}
                      onKeyDown={(event) => {
                        const next =
                          event.key === 'Home'
                            ? 'answer'
                            : event.key === 'End'
                              ? 'question'
                              : ['ArrowLeft', 'ArrowRight'].includes(event.key)
                                ? tab === 'answer'
                                  ? 'question'
                                  : 'answer'
                                : null
                        if (!next) return
                        event.preventDefault()
                        setTabs({ ...tabs, [decision.id]: next })
                        document.getElementById(`${tabId}-${next}`)?.focus()
                      }}
                      data-decision-tab={tab}
                      onClick={() => setTabs({ ...tabs, [decision.id]: tab })}
                    >
                      {t(tab === 'answer' ? 'manager.answerTab' : 'manager.questionTab')}
                      {tab === 'question' && draft?.question?.trim() ? (
                        <span
                          role="img"
                          className="mg-question-draft"
                          aria-label={t('manager.draft')}
                        >
                          •
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
                <div
                  id={`${tabId}-answer-panel`}
                  role="tabpanel"
                  aria-labelledby={`${tabId}-answer`}
                  hidden={selectedTab !== 'answer'}
                >
                  {decision.status === 'open' ||
                  editing.has(decision.id) ||
                  draft?.optionId ||
                  draft?.text.trim() ? (
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
                          // biome-ignore lint/a11y/noStaticElementInteractions: 卡片代理鼠标点击；键盘选择由内部原生单选按钮负责。
                          // biome-ignore lint/a11y/useKeyWithClickEvents: 键盘选择由内部原生单选按钮负责。
                          <div
                            key={option.id}
                            onClick={(event) => {
                              if (
                                disabled ||
                                busy ||
                                !(event.target instanceof Element) ||
                                event.target.closest('a, button, input, label')
                              )
                                return
                              change(decision, { optionId: option.id })
                            }}
                            className="mg-option"
                            data-selected={draft?.optionId === option.id}
                          >
                            <input
                              id={`option-${manager.id}-${decision.id}-${option.id}`}
                              type="radio"
                              aria-describedby={
                                option.description
                                  ? `option-description-${manager.id}-${decision.id}-${option.id}`
                                  : undefined
                              }
                              name={`manager-${manager.id}-${decision.id}`}
                              checked={draft?.optionId === option.id}
                              onChange={() => change(decision, { optionId: option.id })}
                            />
                            <div className="grow">
                              <label htmlFor={`option-${manager.id}-${decision.id}-${option.id}`}>
                                <b>{option.label}</b>
                              </label>
                              {option.description ? (
                                <div
                                  id={`option-description-${manager.id}-${decision.id}-${option.id}`}
                                >
                                  <BoardMarkdown text={option.description} />
                                </div>
                              ) : null}
                            </div>
                            {decision.recommend === option.id ? (
                              <span className="mg-recommend">{t('manager.recommend')}</span>
                            ) : null}
                          </div>
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
                        data-act="manager-answer"
                        className="req-input"
                        rows={2}
                        aria-label={t('manager.answer')}
                        placeholder={t('manager.answer')}
                        disabled={disabled || busy}
                        value={draft?.text ?? ''}
                        onChange={(event) => change(decision, { text: event.target.value })}
                      />
                      <div className="mg-actions">
                        {decision.status !== 'open' ? (
                          <button
                            type="button"
                            className="btn ghost"
                            data-act="manager-cancel-answer-edit"
                            disabled={disabled || busy}
                            onClick={() => {
                              save(cancelAnswerEdit(drafts, decision.id))
                              setEditing(new Set([...editing].filter((id) => id !== decision.id)))
                            }}
                          >
                            {t('manager.cancelEdit')}
                          </button>
                        ) : null}
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
                      </div>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn ghost"
                        data-act="manager-edit-answer"
                        disabled={disabled || busy}
                        onClick={() => {
                          setEditing(new Set([...editing, decision.id]))
                          change(decision, {
                            optionId: decision.answer?.optionId ?? null,
                            text: decision.answer?.text ?? '',
                          })
                        }}
                      >
                        {t('manager.editAnswer')}
                      </button>
                      {decision.answer ? (
                        <p>
                          {
                            decision.options.find(
                              (option) => option.id === decision.answer?.optionId,
                            )?.label
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
                        <div className="mg-item-meta">
                          <div className="mg-item-meta-row">
                            <span className="mg-meta-label">{t('manager.landed')}</span>
                            <BoardLinks links={decision.landed} />
                          </div>
                        </div>
                      ) : null}
                      {decision.status !== 'answered' ? (
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={disabled || busy}
                          onClick={() => void reopen(decision)}
                          data-act="manager-reopen"
                        >
                          {t('manager.reopen')}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
                <div
                  id={`${tabId}-question-panel`}
                  role="tabpanel"
                  aria-labelledby={`${tabId}-question`}
                  hidden={selectedTab !== 'question'}
                >
                  {stale ? (
                    <div className="mg-conflict" role="alert">
                      <p>{t('manager.conflict')}</p>
                      <button
                        type="button"
                        className="btn"
                        disabled={disabled || busy}
                        onClick={() => change(decision, { revision: decision.revision })}
                      >
                        {t('manager.confirm')}
                      </button>
                    </div>
                  ) : null}
                  {selectedTab === 'question' ? (
                    <DecisionQuestions
                      question={draft?.question ?? ''}
                      onQuestion={(question) => change(decision, { question })}
                      manager={manager}
                      decision={decision}
                      disabled={disabled || busy}
                    />
                  ) : null}
                </div>
                <footer className="mg-item-meta">
                  <div className="mg-item-meta-row">
                    <span className="mg-meta-label">{t('manager.basis')}</span>
                    <BoardLinks links={decision.basis} />
                  </div>
                  {decision.checked ? (
                    <div className="mg-item-meta-row">
                      <span className="mg-meta-label">{t('manager.verification')}</span>
                      <span>
                        {decision.checked.commit ? `${decision.checked.commit.slice(0, 8)} · ` : ''}
                        {new Date(decision.checked.at).toLocaleString()}
                      </span>
                    </div>
                  ) : null}
                </footer>
              </article>
            )
          })}
        </div>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {pending.length || requestReplies.length ? (
        <footer className="mg-send">
          <span className="grow">
            {t('manager.unsent', {
              n: new Set(pending.map((entry) => entry.decisionId)).size + requestReplies.length,
            })}
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={disabled || busy}
            onClick={() => {
              save({})
              try {
                writeRequests({})
              } catch {
                setError(t('manager.savedFail'))
              }
            }}
          >
            {t('manager.clear')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-act="manager-submit"
            disabled={disabled || busy || conflict || asking}
            title={
              asking
                ? t('manager.questionWait')
                : conflict
                  ? t(requestConflict ? 'manager.requestConflict' : 'manager.conflict')
                  : disabled
                    ? t(
                        manager.status === 'active'
                          ? 'manager.offline'
                          : manager.status === 'ending'
                            ? 'manager.endingNote'
                            : 'manager.readOnly',
                      )
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
