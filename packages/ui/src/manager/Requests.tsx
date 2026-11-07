import {
  managerRequestStatus,
  requestDraftState,
  sortManagerIssues,
  submitManagerRequest,
} from '@litch/core'
import { useLayoutEffect, useRef, useState } from 'react'
import type {
  ManagerRequestId,
  ManagerRequestView,
  ManagerSubmittedRequest,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { useCardMotion } from './card-motion.ts'
import { DraftEnded } from './DraftEnded.tsx'
import { useManagerFeatures } from './data.ts'
import { useIssueOrder } from './issue-order.tsx'
import { PostCard } from './PostCard.tsx'
import { PostDiscussion, PostHistory } from './PostDiscussion.tsx'
import { usePostDrafts } from './post-drafts.ts'
import { Relations } from './Relations.tsx'
import { useRequestDrafts } from './request-drafts.ts'

export function Requests({
  manager,
  posts,
  requests,
  disabled,
  target,
  onLocated,
}: {
  manager: ManagerView
  posts: ManagerPost[]
  requests: ManagerRequestView[]
  disabled: boolean
  target: { id: ManagerRequestId } | null
  onLocated(): void
}) {
  const t = useT()
  const { channel } = useServices()
  const { drafts, write, clear } = useRequestDrafts(manager.deviceId, manager.id)
  const { advance } = usePostDrafts(manager.deviceId, manager.id)
  const [ignoring, setIgnoring] = useState<{ id: string; revision: number; reason: string } | null>(
    null,
  )
  const [submitting, setSubmitting] = useState<string | null>(null)
  const inFlight = useRef(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const order = useIssueOrder()
  // 单卡与批量提交都经 feedback/submit；没有该能力时禁用并说明。
  const features = useManagerFeatures()
  const old = !features.feedback
  const oldTitle = old ? t('manager.oldDeviceShort') : undefined
  useLayoutEffect(() => {
    if (!target) return
    const card = root.current?.querySelector<HTMLElement>(`[data-manager-request="${target.id}"]`)
    if (!card) return
    card.scrollIntoView({ block: 'center' })
    card.focus({ preventScroll: true })
    onLocated()
  }, [target, onLocated])
  const change = (request: ManagerRequestView, patch: Partial<ManagerSubmittedRequest>) => {
    try {
      write({
        ...drafts,
        [request.id]: {
          requestId: request.id,
          revision: request.revision,
          delivered: false,
          text: '',
          ...drafts[request.id],
          ...patch,
        },
      })
      setError('')
    } catch {
      setError(t('manager.savedFail'))
    }
  }
  const submit = async (request: ManagerRequestView, delivered: boolean, ignored = false) => {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitting(request.id)
    setError('')
    try {
      const accepted = await submitManagerRequest(channel, manager.deviceId, manager.id, {
        requestId: request.id,
        revision: ignored
          ? (ignoring?.revision ?? request.revision)
          : (drafts[request.id]?.revision ?? request.revision),
        delivered,
        text: ignored ? (ignoring?.reason ?? '') : (drafts[request.id]?.text ?? ''),
        ...(ignored ? { ignored: true } : {}),
      })
      if (!accepted) throw new Error(t('manager.requestSubmitFailed'))
      if (!ignored) clear(request.id)
      setIgnoring(null)
      advance([accepted])
    } catch (error) {
      setError(error instanceof Error ? error.message : t('manager.savedFail'))
    } finally {
      inFlight.current = false
      setSubmitting(null)
    }
  }
  const sorted = sortManagerIssues(requests, order, (r) => ({
    at: r.createdAt,
    pending: r.status === 'open',
  }))
  useCardMotion(root, order, sorted.map((request) => request.id).join('|'))
  return (
    <div className="mg-stack" ref={root}>
      {!requests.length ? <p className="mg-empty">{t('manager.none')}</p> : null}
      {sorted.map((request) => {
        const post = posts.find((post) => post.id === request.id)
        const draft = drafts[request.id]
        // 在别处交付、回复或已取消：草稿留着但不计数、不提交（规则见 core 的 requestDraftState）
        const state = draft
          ? requestDraftState({ decisions: [], changes: [], requests }, request.id, draft.revision)
              .state
          : null
        const ended = state === 'ended' && Boolean(draft?.delivered || draft?.text.trim())
        const editing = request.status === 'open' || (Boolean(draft) && state !== 'ended')
        const locked = disabled || submitting !== null || request.status === 'cancelled'
        return (
          <PostCard
            className="mg-card mg-request"
            manager={manager}
            id={request.id}
            text={request.description}
            closed={request.status !== 'open'}
            heading={
              <>
                <span className="mono dim">{request.id}</span>
                <h3 className="grow">{request.title}</h3>
                <span className={request.status === 'open' ? 'pill wait' : 'pill mute'}>
                  {t(`manager.request.${managerRequestStatus(request)}`)}
                </span>
                {draft && !ended ? <span className="pill wait">{t('manager.draft')}</span> : null}
              </>
            }
            discussion={(collapsed) => (
              <PostDiscussion compact={collapsed} manager={manager} post={post} disabled={locked} />
            )}
            data-manager-request={request.id}
            data-motion-key={request.id}
            key={request.id}
            tabIndex={-1}
          >
            <Relations id={request.id} />
            <BoardMarkdown text={request.description} />
            <PostHistory post={post} />
            {request.response ? (
              <section className="mg-request-response">
                <header>
                  <b>{t('manager.yourReply')}</b>
                  <Stamp className="dim" at={request.response.at} />
                </header>
                {request.response.text ? <BoardMarkdown text={request.response.text} /> : null}
              </section>
            ) : null}
            {request.cancelled ? <p className="dim">{request.cancelled.reason}</p> : null}
            {ended && draft ? (
              <DraftEnded
                text={t(
                  request.status === 'cancelled'
                    ? 'manager.draftEnded.cancelled'
                    : 'manager.draftEnded.handled',
                )}
                onDiscard={() => {
                  try {
                    const { [request.id]: _discarded, ...rest } = drafts
                    write(rest)
                    setError('')
                  } catch {
                    setError(t('manager.savedFail'))
                  }
                }}
              >
                {draft.delivered ? (
                  <p>
                    <b>{request.buttonLabel ?? t('manager.requestDone')}</b>
                  </p>
                ) : null}
                {draft.text.trim() ? <BoardMarkdown text={draft.text} /> : null}
              </DraftEnded>
            ) : null}
            {draft && state === 'conflict' ? (
              <div className="mg-conflict" role="alert">
                <p>{t('manager.requestConflict')}</p>
                <button
                  type="button"
                  className="btn"
                  disabled={locked}
                  onClick={() => change(request, { revision: request.revision })}
                >
                  {t('manager.confirm')}
                </button>
              </div>
            ) : null}
            {request.status === 'open' ? (
              <button
                type="button"
                className="btn ghost"
                data-act="manager-request-ignore"
                disabled={locked || !features.requestIgnore}
                title={!features.requestIgnore ? t('manager.oldDeviceShort') : undefined}
                onClick={() =>
                  setIgnoring({ id: request.id, revision: request.revision, reason: '' })
                }
              >
                {t('manager.ignore')}
              </button>
            ) : null}
            {request.status === 'open' && ignoring?.id === request.id ? (
              <section className="mg-conflict" data-request-ignore-form>
                <p>{t('manager.requestIgnoreNote')}</p>
                <textarea
                  className="req-input"
                  rows={2}
                  data-act="manager-request-ignore-reason"
                  aria-label={t('manager.ignoreReason')}
                  placeholder={t('manager.ignoreReason')}
                  disabled={locked}
                  value={ignoring.reason}
                  onChange={(event) => setIgnoring({ ...ignoring, reason: event.target.value })}
                />
                <button
                  type="button"
                  className="btn"
                  data-act="manager-request-ignore-confirm"
                  disabled={locked || !features.requestIgnore}
                  onClick={() => void submit(request, false, true)}
                >
                  {t('manager.ignoreConfirm')}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={locked}
                  onClick={() => setIgnoring(null)}
                >
                  {t('manager.cancel')}
                </button>
              </section>
            ) : null}
            {request.status !== 'cancelled' && editing ? (
              <>
                <textarea
                  disabled={locked || old}
                  title={oldTitle}
                  className="req-input"
                  rows={2}
                  data-act="manager-request-text"
                  value={draft?.text ?? ''}
                  aria-label={t('manager.requestText')}
                  placeholder={t('manager.requestText')}
                  onChange={(event) => change(request, { text: event.target.value })}
                />
                <button
                  type="button"
                  className="btn primary"
                  data-act="manager-request-deliver"
                  disabled={locked || old || state === 'conflict'}
                  title={
                    oldTitle ?? (state === 'conflict' ? t('manager.requestConflict') : undefined)
                  }
                  onClick={() => void submit(request, true)}
                >
                  {submitting === request.id
                    ? t('manager.submitting')
                    : (request.buttonLabel ?? t('manager.requestDone'))}
                </button>
                {draft?.text.trim() ? (
                  <button
                    type="button"
                    className="btn ghost"
                    data-act="manager-request-reply"
                    disabled={locked || old || state === 'conflict'}
                    title={
                      oldTitle ?? (state === 'conflict' ? t('manager.requestConflict') : undefined)
                    }
                    onClick={() => void submit(request, false)}
                  >
                    {t('manager.submit')}
                  </button>
                ) : null}
                {request.response && draft ? (
                  <button
                    type="button"
                    className="btn ghost"
                    data-act="manager-request-cancel-edit"
                    disabled={locked}
                    onClick={() => {
                      try {
                        const next = { ...drafts }
                        delete next[request.id]
                        write(next)
                        setError('')
                      } catch {
                        setError(t('manager.savedFail'))
                      }
                    }}
                  >
                    {t('manager.cancelEdit')}
                  </button>
                ) : null}
                {old ? (
                  <p className="dim" data-old-device-reason>
                    {t('manager.oldDeviceShort')}
                  </p>
                ) : null}
              </>
            ) : request.status !== 'cancelled' ? (
              <button
                type="button"
                className="btn ghost"
                data-act="manager-request-edit"
                disabled={locked || old}
                title={oldTitle}
                onClick={() =>
                  change(request, {
                    delivered: request.response?.delivered ?? false,
                    text: request.response?.text ?? '',
                  })
                }
              >
                {t('manager.requestEdit')}
              </button>
            ) : null}
          </PostCard>
        )
      })}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
