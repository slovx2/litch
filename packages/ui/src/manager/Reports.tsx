import { sortManagerIssues } from '@litch/core'
import { useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { ManagerPost } from '../../../protocol/src/manager-posts.mjs'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { useManagerFeatures } from './data.ts'
import { useIssueOrder } from './issue-order.tsx'
import { PostCard } from './PostCard.tsx'
import { PostDiscussion, PostHistory } from './PostDiscussion.tsx'
import { Relations } from './Relations.tsx'
export function Reports({
  manager,
  posts,
  disabled,
}: {
  manager: ManagerView
  posts: ManagerPost[]
  disabled: boolean
}) {
  const t = useT()
  const { channel } = useServices()
  const [busy, setBusy] = useState('')
  const order = useIssueOrder()
  const [error, setError] = useState('')
  const features = useManagerFeatures()
  const read = async (post: ManagerPost) => {
    setBusy(post.id)
    try {
      await channel.command('managers.report.read', {
        deviceId: manager.deviceId,
        managerId: manager.id,
        id: post.id as `P-${number}`,
        revision: post.revision,
      })
      setError('')
    } catch (e) {
      setError(reasonOf(e, t))
    } finally {
      setBusy('')
    }
  }
  return (
    <div className="mg-stack">
      {!posts.length ? <p className="mg-empty">{t('manager.none')}</p> : null}
      {sortManagerIssues(posts, order, (p) => ({ at: p.createdAt, pending: p.unread })).map(
        (post) => (
          <PostCard
            className="mg-card"
            manager={manager}
            id={post.id}
            text={post.body}
            closed={!post.unread}
            heading={
              <>
                <span className="mono dim">{post.id}</span>
                <h3 className="grow">{post.title}</h3>
                <span className={post.unread ? 'pill wait' : 'pill mute'}>
                  {t(post.unread ? 'manager.reportUnread' : 'manager.reportRead')}
                </span>
              </>
            }
            discussion={(collapsed) => (
              <PostDiscussion
                compact={collapsed}
                manager={manager}
                post={post}
                disabled={disabled}
              />
            )}
            data-report={post.id}
            tabIndex={-1}
            key={post.id}
          >
            <Relations id={post.id} />
            <BoardMarkdown text={post.body} />
            <PostHistory post={post} />
            {post.unread ? (
              <button
                type="button"
                className="btn"
                disabled={disabled || !!busy || !features.posts}
                title={features.posts ? undefined : t('manager.oldDeviceShort')}
                data-act="report-read"
                onClick={() => void read(post)}
              >
                {t('manager.markRead')}
              </button>
            ) : null}
            {post.unread && !features.posts ? (
              <span className="dim" data-old-device-reason>
                {' '}
                {t('manager.oldDeviceShort')}
              </span>
            ) : null}
          </PostCard>
        ),
      )}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
