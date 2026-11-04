import {
  decisionDraftState,
  liveManagerDrafts,
  type ManagerBoardPages,
  sortManagerIssues,
} from '@litch/core'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  ManagerChangeView,
  ManagerDecisionId,
  ManagerDecisionView,
  ManagerRequestView,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import type { ManagerDraftBoard } from '../../../core/src/projection/manager-drafts.mts'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardLinks } from './BoardLinks.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { BoardReferences } from './BoardReferences.tsx'
import { useCardMotion } from './card-motion.ts'
import { DecisionAnswer, DecisionHistory, DecisionOutcome } from './DecisionOutcome.tsx'
import { DraftEnded } from './DraftEnded.tsx'
import { useManagerFeatures } from './data.ts'
import { focusDecisionAfterSubmit, nextPendingDecision } from './decision-submit-focus.ts'
import {
  type AnswerDrafts,
  cancelAnswerEdit,
  type DecisionDraft,
  refreshAnswerDrafts,
  useAnswerDrafts,
} from './drafts.ts'
import { IssueOrderSelect, useIssueOrder } from './issue-order.tsx'
import { PostCard } from './PostCard.tsx'
import { PostDiscussion, PostHistory } from './PostDiscussion.tsx'
import { advancePostDrafts, usePostDrafts } from './post-drafts.ts'
import { Relations } from './Relations.tsx'
import { useRequestDrafts } from './request-drafts.ts'

export function Decisions({
  manager,
  posts,
  onBusy,
  decisions,
  changes,
  requests,
  groups,
  disabled,
  visible,
  target,
  onLocated,
  onlyId,
  part = 'all',
  draftBoard,
}: {
  manager: ManagerView
  posts: ManagerPost[]
  onBusy(value: boolean): void
  decisions: ManagerDecisionView[]
  changes: ManagerChangeView[]
  requests: ManagerRequestView[]
  groups: ManagerBoardPages['decisions']
  disabled: boolean
  visible: boolean
  target: { id: ManagerDecisionId } | null
  onLocated(): void
  onlyId?: string | null
  /** 分页看板把卡片和提交条分开放：卡片在展开的卡里，提交条固定在列表底部 */
  part?: 'all' | 'cards' | 'send'
  /** 分页看板只带点开过的详情，草稿状态改用补了卡头的判断面（core 的 pagedDraftBoard） */
  draftBoard?: ManagerDraftBoard
}) {
  const t = useT()
  const { channel } = useServices()
  const { drafts: savedDrafts, write } = useAnswerDrafts(manager.deviceId, manager.id)
  const { drafts: requestDrafts, write: writeRequests } = useRequestDrafts(
    manager.deviceId,
    manager.id,
  )
  const { drafts: postDrafts, write: writePosts } = usePostDrafts(manager.deviceId, manager.id)
  // 议题在别处答复、关闭、忽略或取消后，草稿不计数、不提交（卡片上另有提示）；重新打开后自动回来
  const board = draftBoard ?? { decisions, changes, requests, posts }
  const refreshed = refreshAnswerDrafts(board, savedDrafts)
  const drafts = refreshed.drafts
  const [clearedSelections, setClearedSelections] = useState<Set<string>>(new Set())
  const live = liveManagerDrafts(board, {
    decisions: Object.values(drafts),
    requests: Object.values(requestDrafts),
    posts: Object.values(postDrafts),
  })
  // 比应用旧的设备服务：没宣告 Feedback 只交决策答复（核心改走 answers/submit），没宣告 Posts 不交议题追问；
  // 那些草稿留着，升级后再交
  const features = useManagerFeatures()
  const postQuestions = features.posts ? live.posts : []
  const requestReplies = features.feedback ? live.requests : []
  const [filter, setFilter] = useState<'open' | 'answered' | 'closed' | 'ignored'>('open')
  const [editing, setEditing] = useState<Set<string>>(new Set())
  /** 正在填忽略理由的那张卡 */
  const [ignoring, setIgnoring] = useState<{ id: ManagerDecisionId; reason: string } | null>(null)
  const cards = useRef<HTMLDivElement>(null)
  const listHead = useRef<HTMLDivElement>(null)
  const [submittedFocus, setSubmittedFocus] = useState<{
    before: string[]
    accepted: string[]
  } | null>(null)
  const targetDecision = target
    ? decisions.find((decision) => decision.id === target.id)
    : undefined
  const targetGroup =
    targetDecision?.status === 'open'
      ? 'open'
      : targetDecision?.status === 'answered'
        ? 'answered'
        : targetDecision?.status === 'ignored'
          ? 'ignored'
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
  /** 刚交出去的项数：提交条留一会儿报“已提交”，再收起 */
  const [sent, setSent] = useState(0)
  useEffect(() => {
    if (!sent) return
    const timer = setTimeout(() => setSent(0), 2500)
    return () => clearTimeout(timer)
  }, [sent])
  const footer = useRef<HTMLElement>(null)
  const located = useRef<HTMLElement | null>(null)
  /** 点草稿数：滚到当前位置之后的下一张有草稿的卡，到底了回到第一张 */
  const locateDraft = () => {
    const host = footer.current?.closest('.mg-body')
    if (!host) return
    const marked = [
      ...host.querySelectorAll<HTMLElement>(
        '[data-draft="true"], [data-draft-mark="live"], [data-draft-mark="conflict"]',
      ),
    ]
    const top = host.getBoundingClientRect().top
    let next =
      marked.find((card) => card.getBoundingClientRect().top - top > 8) ?? marked[0] ?? null
    // 列表末尾的卡滚不到顶：又落到上次那张时换下一张，到底了回到第一张
    if (next && next === located.current)
      next = marked[(marked.indexOf(next) + 1) % marked.length] ?? null
    located.current = next
    next?.scrollIntoView({ block: 'start' })
    next?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    const refreshed = refreshAnswerDrafts(board, savedDrafts)
    if (refreshed.drafts === savedDrafts) return
    try {
      write(refreshed.drafts)
      setClearedSelections((previous) => new Set([...previous, ...refreshed.cleared]))
    } catch {
      setError(t('manager.savedFail'))
    }
  }, [savedDrafts, board, write, t])
  const answers = live.answers.map(({ question: _question, ...answer }) => answer)
  const questions = (features.feedback ? live.questions : []).map((draft) => ({
    decisionId: draft.decisionId,
    revision: draft.revision,
    question: draft.question?.trim() ?? '',
  }))
  const pending = [...answers, ...questions]
  const asking = pending.some((answer) =>
    decisions
      .find((decision) => decision.id === answer.decisionId)
      ?.discussion?.messages.some(
        (entry) => entry.status === 'running' && entry.mode !== 'manager',
      ),
  )
  /** 设备服务较旧、这次交不了而留着的草稿数 */
  const held =
    live.posts.length - postQuestions.length + live.requests.length - requestReplies.length
  const heldQuestions = live.questions.length - questions.length
  const requestConflict = features.feedback && live.requestConflict
  const conflict = live.conflict || requestConflict
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
  const endedCount = live.ended.decisions.size + live.ended.requests.size + live.ended.posts.size
  const unsent =
    new Set(pending.map((entry) => entry.decisionId)).size +
    requestReplies.length +
    postQuestions.length
  const submit = async () => {
    if (
      busy ||
      disabled ||
      conflict ||
      asking ||
      (!pending.length && !requestReplies.length && !postQuestions.length)
    )
      return
    setBusy(true)
    setError('')
    try {
      const result =
        pending.length || requestReplies.length
          ? await channel.command('managers.feedback.submit', {
              deviceId: manager.deviceId,
              managerId: manager.id,
              answers,
              questions,
              requests: requestReplies,
            })
          : {
              accepted: [],
              rejected: [],
              acceptedRequests: [],
              rejectedRequests: [],
              acceptedQuestions: [],
              rejectedQuestions: [],
              delivery: 'none',
            }
      const next = { ...drafts }
      // 只接续正在看的待定列表，不改变分栏；失败项保留在原处，追问与其他类别提交不抢焦点。
      if (visible && filter === 'open' && result.accepted.length)
        setSubmittedFocus({
          before: grouped.open.map((decision) => decision.id),
          accepted: result.accepted.map((decision) => decision.id),
        })
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
      const postNext = advancePostDrafts(postDrafts, result.acceptedRequests)
      writePosts(postNext)
      const sending = new Set(postQuestions.map((draft) => draft.id))
      for (const draft of Object.values(postNext).filter(
        (draft) => draft.question.trim() && sending.has(draft.id),
      )) {
        await channel.command('managers.post.question', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          ...draft,
          mode: 'manager',
        })
        delete postNext[draft.id]
        writePosts({ ...postNext })
      }
      const rejected = [...result.rejected, ...result.rejectedQuestions]
      if (!rejected.length && !result.rejectedRequests.length) setSent(unsent)
      if (rejected.length || result.rejectedRequests.length)
        setError(
          t('manager.rejected', {
            reason: [
              ...rejected.map((entry) => `${entry.decisionId}: ${entry.message}`),
              ...result.rejectedRequests.map((entry) => `${entry.requestId}: ${entry.message}`),
            ].join(' · '),
          }),
        )
      setEditing(new Set())
    } catch (cause) {
      setError(reasonOf(cause, t))
    } finally {
      setBusy(false)
    }
  }
  const ignore = async (decision: ManagerDecisionView, reason: string) => {
    setBusy(true)
    setError('')
    try {
      await channel.command('managers.decision.ignore', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        decisionId: decision.id,
        revision: decision.revision,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      setIgnoring(null)
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
  const order = useIssueOrder()
  const sorted = (rows: ManagerDecisionView[]) =>
    sortManagerIssues(rows, order, (d) => ({ at: d.createdAt, pending: d.status === 'open' }))
  const grouped = {
    open: sorted(groups.pending),
    answered: sorted(groups.answered),
    closed: sorted(groups.closed),
    ignored: sorted(groups.ignored),
  }
  const displayed =
    onlyId === undefined ? grouped[filter] : decisions.filter((decision) => decision.id === onlyId)
  useLayoutEffect(() => {
    if (!submittedFocus || busy) return
    if (!visible || filter !== 'open' || target) {
      setSubmittedFocus(null)
      return
    }
    // 命令回包和看板订阅可能先后到：等成功项真的离开待定，再接续焦点。
    if (groups.pending.some((decision) => submittedFocus.accepted.includes(decision.id))) return
    const next = nextPendingDecision(
      submittedFocus.before,
      submittedFocus.accepted,
      groups.pending.map((decision) => decision.id),
    )
    const element = next
      ? cards.current?.querySelector<HTMLElement>(`[data-decision="${next}"]`)
      : listHead.current
    if (element) focusDecisionAfterSubmit(element)
    setSubmittedFocus(null)
  }, [submittedFocus, busy, visible, filter, target, groups.pending])
  // 提交、忽略、重开后离开当前分栏的卡收拢，下方的卡补位；换分栏不过渡。放在接续焦点之后，先定焦点再过渡
  useCardMotion(
    cards,
    `${filter}|${onlyId ?? ''}|${part}`,
    displayed.map((decision) => decision.id).join('|'),
  )
  return (
    <>
      <div hidden={!visible || part === 'send'}>
        {onlyId === undefined ? (
          <div className="mg-decision-filter" ref={listHead} tabIndex={-1}>
            {(['open', 'answered', 'closed', 'ignored'] as const).map((key) => (
              <button
                type="button"
                key={key}
                data-filter={key}
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                <span aria-hidden="true">
                  {key === 'open' ? '○' : key === 'answered' ? '✓' : key === 'closed' ? '⊘' : '◌'}
                </span>{' '}
                {grouped[key].length} {t(`manager.${key}`)}
              </button>
            ))}
            <IssueOrderSelect withPending={false} />
          </div>
        ) : null}
        <div className="mg-stack" ref={cards}>
          {displayed.length === 0 ? <p className="mg-empty">{t('manager.none')}</p> : null}
          {displayed.map((decision) => {
            const draft = drafts[decision.id]
            const post = posts.find((post) => post.id === decision.id)
            const ended = live.ended.decisions.has(decision.id)
            const stale =
              draft && decisionDraftState(board, decision.id, draft.revision).state === 'conflict'
            const chosen = decision.options.find((option) => option.id === draft?.optionId)
            const endedNote =
              ended && draft ? (
                <DraftEnded
                  text={t(
                    decision.status === 'answered'
                      ? 'manager.draftEnded.answered'
                      : decision.status === 'ignored'
                        ? 'manager.draftEnded.ignored'
                        : 'manager.draftEnded.closed',
                  )}
                  disabled={busy}
                  onDiscard={() => {
                    const { [decision.id]: _discarded, ...rest } = drafts
                    save(rest)
                  }}
                >
                  {chosen ? (
                    <p>
                      <b>{chosen.label}</b>
                    </p>
                  ) : null}
                  {draft.text.trim() ? <BoardMarkdown text={draft.text} /> : null}
                  {draft.question?.trim() ? (
                    <p>
                      {t('manager.questionYou')} {draft.question}
                    </p>
                  ) : null}
                </DraftEnded>
              ) : null
            return (
              <PostCard
                className="mg-decision"
                manager={manager}
                id={decision.id}
                text={decision.background}
                closed={decision.status !== 'open'}
                heading={
                  <>
                    <span className="mono dim">{decision.id}</span>
                    <h3>{decision.title}</h3>
                    {clearedSelections.has(decision.id) ? (
                      <small className="dim mg-selection-reset" data-selection-reset role="status">
                        {t('manager.selectionReset')}
                      </small>
                    ) : null}
                    {draft && !ended ? (
                      <span className="pill wait">{t('manager.draft')}</span>
                    ) : null}
                  </>
                }
                discussion={(collapsed) => (
                  <PostDiscussion
                    compact={collapsed}
                    manager={manager}
                    post={post}
                    disabled={disabled || busy}
                    question={draft?.question ?? ''}
                    questionBlocked={ended}
                    questionStale={Boolean(stale)}
                    onQuestion={(question) => change(decision, { question })}
                  />
                )}
                data-decision={decision.id}
                data-motion-key={decision.id}
                key={decision.id}
                data-draft={Boolean(draft) && !ended}
                tabIndex={-1}
              >
                <Relations id={decision.id} />
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
                <PostHistory post={post} />
                <div>
                  {decision.status === 'open' ||
                  editing.has(decision.id) ||
                  (!ended && (draft?.optionId || draft?.text.trim())) ? (
                    <>
                      {stale ? (
                        <div className="mg-conflict" role="alert">
                          <p>{t('manager.conflict')}</p>
                          <button
                            type="button"
                            className="btn"
                            data-act="manager-confirm-version"
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
                      {decision.status === 'open' ? (
                        <>
                          <DecisionAnswer decision={decision} />
                          <DecisionHistory decision={decision} />
                        </>
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
                            data-act="manager-clear-option"
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
                        {decision.status === 'open' && ignoring?.id !== decision.id ? (
                          <button
                            type="button"
                            className="btn ghost"
                            data-act="manager-ignore"
                            disabled={disabled || busy || !features.ignore}
                            title={features.ignore ? undefined : t('manager.oldDeviceShort')}
                            onClick={() => setIgnoring({ id: decision.id, reason: '' })}
                          >
                            {t('manager.ignore')}
                          </button>
                        ) : null}
                      </div>
                      {decision.status === 'open' && ignoring?.id === decision.id ? (
                        <div className="mg-ignore" data-ignore-form>
                          <p className="dim">{t('manager.ignoreNote')}</p>
                          <textarea
                            data-act="manager-ignore-reason"
                            className="req-input"
                            rows={1}
                            aria-label={t('manager.ignoreReason')}
                            placeholder={t('manager.ignoreReason')}
                            disabled={disabled || busy}
                            value={ignoring.reason}
                            onChange={(event) =>
                              setIgnoring({ id: decision.id, reason: event.target.value })
                            }
                          />
                          <div className="mg-actions">
                            <button
                              type="button"
                              className="btn ghost"
                              disabled={busy}
                              onClick={() => setIgnoring(null)}
                            >
                              {t('manager.cancel')}
                            </button>
                            <button
                              type="button"
                              className="btn"
                              data-act="manager-ignore-confirm"
                              disabled={disabled || busy}
                              onClick={() => void ignore(decision, ignoring.reason)}
                            >
                              {t('manager.ignoreConfirm')}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <DecisionOutcome decision={decision} />
                      {/* 先是答复、关闭或忽略的记录，再说留着的草稿怎么办 */}
                      {endedNote}
                      {decision.answer || decision.status === 'answered' ? (
                        <button
                          type="button"
                          className="btn ghost"
                          data-act="manager-edit-answer"
                          disabled={disabled || busy}
                          onClick={() => {
                            setEditing(new Set([...editing, decision.id]))
                            // 对着当前这一版改：留着的旧草稿版本不算数
                            change(decision, {
                              revision: decision.revision,
                              optionId: decision.answer?.optionId ?? null,
                              text: decision.answer?.text ?? '',
                            })
                          }}
                        >
                          {t('manager.editAnswer')}
                        </button>
                      ) : null}
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
                          data-act={
                            decision.status === 'ignored' ? 'manager-unignore' : 'manager-reopen'
                          }
                        >
                          {t(decision.status === 'ignored' ? 'manager.unignore' : 'manager.reopen')}
                        </button>
                      ) : null}
                    </>
                  )}
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
                        <Stamp at={decision.checked.at} />
                      </span>
                    </div>
                  ) : null}
                </footer>
              </PostCard>
            )
          })}
        </div>
      </div>
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {part !== 'cards' && !unsent && !held && !heldQuestions && sent ? (
        <footer className="mg-send" ref={footer} data-sent role="status">
          <span className="grow">
            <span aria-hidden="true">✓</span> {t('manager.sent', { n: sent })}
          </span>
        </footer>
      ) : null}
      {part !== 'cards' && (unsent || held || heldQuestions) ? (
        <footer className="mg-send" ref={footer}>
          <span className="grow">
            <button
              type="button"
              className="mg-send-count"
              data-act="manager-locate-draft"
              title={t('manager.locateDraft')}
              onClick={locateDraft}
            >
              {t('manager.unsent', { n: unsent })} <span aria-hidden="true">↓</span>
            </button>
            {endedCount ? (
              <span className="dim" data-ended-drafts>
                {' · '}
                {t('manager.endedDrafts', { n: endedCount })}
              </span>
            ) : null}
            {held || heldQuestions ? (
              <span className="dim" data-old-device-held>
                {' · '}
                {t('manager.oldDeviceHeld', { n: held + heldQuestions })}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={disabled || busy}
            onClick={() => {
              save({})
              try {
                writeRequests({})
                writePosts({})
              } catch {
                setError(t('manager.savedFail'))
              }
            }}
          >
            {t('manager.clear')}
          </button>
          <button
            type="button"
            className={requestReplies.length && !pending.length ? 'btn' : 'btn primary'}
            data-act="manager-submit"
            disabled={
              disabled ||
              busy ||
              conflict ||
              asking ||
              (!pending.length && !requestReplies.length && !postQuestions.length)
            }
            title={
              !pending.length && !requestReplies.length && !postQuestions.length
                ? t('manager.oldDeviceShort')
                : asking
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
