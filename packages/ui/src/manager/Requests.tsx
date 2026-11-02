import { requestDraftState, sortManagerIssues } from '@litch/core'
import { useLayoutEffect, useRef, useState } from 'react'
import type {
  ManagerRequestId,
  ManagerRequestView,
  ManagerSubmittedRequest,
  ManagerView,
} from '../../../core/src/model-manager.mts'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import { useT } from '../app/appearance.ts'
import { Stamp } from '../transcript/Stamp.tsx'
import { BoardLinks } from './BoardLinks.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { DraftEnded } from './DraftEnded.tsx'
import { useManagerFeatures } from './data.ts'
import { useIssueOrder } from './issue-order.tsx'
import { PostDiscussion, PostHistory } from './PostDiscussion.tsx'
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
  const { drafts, write } = useRequestDrafts(manager.deviceId, manager.id)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const order = useIssueOrder()
  // 交付与回复随“提交给经理”经 feedback/submit 交：比应用旧的设备服务没有，入口禁用并写明原因
  const old = !useManagerFeatures().feedback
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
  return (
    <div className="mg-stack" ref={root}>
      {!requests.length ? <p className="mg-empty">{t('manager.none')}</p> : null}
      {sortManagerIssues(requests, order, (r) => ({
        at: r.createdAt,
        pending: r.status === 'open',
      })).map((request) => {
        const post = posts.find((post) => post.id === request.id)
        const draft = drafts[request.id]
        // 在别处交付、回复或已取消：草稿留着但不计数、不提交（规则见 core 的 requestDraftState）
        const state = draft
          ? requestDraftState({ decisions: [], changes: [], requests }, request.id, draft.revision)
              .state
          : null
        const ended = state === 'ended' && Boolean(draft?.delivered || draft?.text.trim())
        const editing = request.status === 'open' || (Boolean(draft) && state !== 'ended')
        const locked = disabled || request.status === 'cancelled'
        return (
          <article
            className="mg-card mg-request"
            data-manager-request={request.id}
            key={request.id}
            tabIndex={-1}
          >
            <header>
              <span className="mono dim">{request.id}</span>
              <h3 className="grow">{request.title}</h3>
              <span className={request.status === 'open' ? 'pill wait' : 'pill mute'}>
                {t(`manager.request.${request.status}`)}
              </span>
              {draft && !ended ? <span className="pill wait">{t('manager.draft')}</span> : null}
            </header>
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
                  disabled={locked || old}
                  title={oldTitle}
                  aria-pressed={draft?.delivered ?? false}
                  onClick={() => change(request, { delivered: !draft?.delivered })}
                >
                  {request.buttonLabel ?? t('manager.requestDone')}
                  {draft?.delivered ? ` · ${t('manager.draft')}` : ''}
                </button>
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
            <PostDiscussion manager={manager} post={post} disabled={locked} />
            {request.basis.length || request.links.length ? (
              <footer className="mg-item-meta">
                {request.basis.length ? (
                  <div className="mg-item-meta-row">
                    <span className="mg-meta-label">{t('manager.basis')}</span>
                    <BoardLinks links={request.basis} />
                  </div>
                ) : null}
                {request.links.length ? (
                  <div className="mg-item-meta-row">
                    <span className="mg-meta-label">{t('manager.links')}</span>
                    <BoardLinks links={request.links} />
                  </div>
                ) : null}
              </footer>
            ) : null}
          </article>
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
