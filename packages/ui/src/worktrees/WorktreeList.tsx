// 设备设置“工作树”一组下面的列表：这台设备上设备层建的全部工作树（worktrees 主题，这一节开着才订阅）。
// 每行写分支、所属会话、状态和路径；在用的能删目录（有改动先留快照，也可以直接丢弃），删了的能建回来，
// 都能连分支一起删（删了就恢复不了，再确认一次）。
import type {
  DeviceView,
  SessionSummary,
  WorktreesOp,
  WorktreesTopicView,
  WorktreeView,
} from '@litch/core'
import { keys } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'
import { baseName } from './labels.ts'

function useWorktrees(device: DeviceView): WorktreesTopicView | undefined {
  const { channel } = useServices()
  const able = device.worktrees && device.connection === 'online'
  const [view, setView] = useState<WorktreesTopicView>()
  useEffect(() => {
    if (!able) {
      setView(undefined)
      return
    }
    return channel.subscribe(
      { kind: 'worktrees', deviceId: device.id },
      {
        snapshot: (data) => setView(data),
        delta: (ops: WorktreesOp[]) => {
          const last = ops.at(-1)
          if (last) setView(last.view)
        },
        error: () => setView(undefined),
      },
    )
  }, [channel, device.id, able])
  return able ? view : undefined
}

/** 主人会话归档了的，不在会话列表里：读一次这台设备的已归档会话，好写出它是谁 */
function useArchivedOnce(device: DeviceView, wanted: boolean): void {
  const { channel } = useServices()
  const online = device.connection === 'online'
  useEffect(() => {
    if (wanted && online)
      channel.command('device.loadArchived', { deviceId: device.id }).catch(() => {})
  }, [channel, device.id, online, wanted])
}

export function WorktreeList({ device }: { device: DeviceView }) {
  const t = useT()
  const view = useWorktrees(device)
  useArchivedOnce(device, Boolean(view?.list?.some((entry) => entry.ownerSessionId)))
  if (!device.worktrees) return null
  let body: React.ReactNode
  if (device.connection !== 'online')
    body = <div className="devp-note">{t('worktree.list.offline')}</div>
  else if (!view || view.list === null) {
    body = view?.error ? (
      <div className="devp-note err">
        {t('worktree.list.failed', { reason: reasonOf(view.error, t) })}
      </div>
    ) : (
      <div className="devp-note">{t('worktree.list.loading')}</div>
    )
  } else if (view.list.length === 0)
    body = <div className="devp-note">{t('worktree.list.empty')}</div>
  else
    body = (
      <ul className="phone-list wt-list">
        {view.list.map((entry) => (
          <WorktreeRow key={entry.id} deviceId={device.id} worktree={entry} />
        ))}
      </ul>
    )
  return (
    <div className="wt-list-wrap" data-worktrees={view?.list?.length ?? ''}>
      <h4>{t('worktree.list.title')}</h4>
      {body}
    </div>
  )
}

type Asking = 'remove' | 'branch' | null

function WorktreeRow({ deviceId, worktree }: { deviceId: string; worktree: WorktreeView }) {
  const { channel } = useServices()
  const t = useT()
  const owner = useKey<SessionSummary>(keys.summary(deviceId, worktree.ownerSessionId ?? ''))
  const archived = useKey<SessionSummary[] | null>(keys.archived(deviceId))
  const shelved = owner ? null : archived?.find((entry) => entry.id === worktree.ownerSessionId)
  const [asking, setAsking] = useState<Asking>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const removed = worktree.state === 'removed'
  const run = (name: 'worktree.remove' | 'worktree.restore', extra: object = {}) => {
    setBusy(true)
    setFailure(null)
    channel
      .command(name, { deviceId, id: worktree.id, ...extra })
      .then(
        () => setAsking(null),
        (error: unknown) =>
          setFailure(t('worktree.list.actionFailed', { reason: reasonOf(error, t) })),
      )
      .finally(() => setBusy(false))
  }
  const state = removed
    ? worktree.snapshotRef
      ? t('worktree.state.removedSnapshot')
      : t('worktree.state.removed')
    : worktree.state === 'kept'
      ? t('worktree.state.kept')
      : worktree.state === 'creating'
        ? t('worktree.state.creating')
        : t('worktree.state.ready')
  return (
    <li className="phone-row wt-row" data-worktree={worktree.id} data-state={worktree.state}>
      <div className="phone-main">
        <span className="phone-name ell mono">{worktree.branch}</span>
        <span className="phone-date">{state}</span>
        <span className="grow" />
        {asking ? null : removed ? (
          <button
            type="button"
            className="btn ghost"
            data-act="worktree-restore"
            disabled={busy}
            onClick={() => run('worktree.restore')}
          >
            {t(busy ? 'worktree.restoring' : 'worktree.restore')}
          </button>
        ) : (
          <button
            type="button"
            className="btn ghost"
            data-act="worktree-remove"
            onClick={() => setAsking('remove')}
          >
            {t('worktree.remove')}
          </button>
        )}
        {asking ? null : (
          <button
            type="button"
            className="btn ghost"
            data-act="worktree-remove-branch"
            onClick={() => setAsking('branch')}
          >
            {t('worktree.removeBranch')}
          </button>
        )}
      </div>
      <div className="wt-facts dim">
        <span className="ell">
          {owner
            ? t.text(owner.title)
            : shelved
              ? t('worktree.list.ownerArchived', { title: t.text(shelved.title) })
              : worktree.ownerSessionId
                ? t('worktree.list.ownerGone')
                : t('worktree.list.noOwner')}
        </span>
        <span>{t('worktree.list.from', { base: baseName(worktree.baseRef, t) })}</span>
        <span className="mono ell">{worktree.path}</span>
      </div>
      {asking === 'remove' ? (
        <div className="phone-ask">
          <span className="devp-ask">{t('worktree.remove.ask')}</span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
            {t('permission.confirm.no')}
          </button>
          <button
            type="button"
            className="btn ghost"
            data-act="worktree-discard"
            disabled={busy}
            onClick={() => run('worktree.remove', { discard: true })}
          >
            {t('worktree.remove.discard')}
          </button>
          <button
            type="button"
            className="btn"
            data-act="worktree-remove-yes"
            disabled={busy}
            onClick={() => run('worktree.remove')}
          >
            {t('worktree.remove.keep')}
          </button>
        </div>
      ) : null}
      {asking === 'branch' ? (
        <div className="phone-ask">
          <span className="devp-ask">
            {t('worktree.removeBranch.ask', { branch: worktree.branch })}
          </span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
            {t('permission.confirm.no')}
          </button>
          <button
            type="button"
            className="btn danger"
            data-act="worktree-remove-branch-yes"
            disabled={busy}
            onClick={() => run('worktree.remove', { withBranch: true })}
          >
            {t('worktree.removeBranch')}
          </button>
        </div>
      ) : null}
      {failure ? (
        <div className="devp-note err" role="alert">
          {failure}
        </div>
      ) : null}
    </li>
  )
}
