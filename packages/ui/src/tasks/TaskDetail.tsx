// 一个定时任务的详情：任务本身（日程、下一次、到点之后做什么、提示词、来历、最近一次失败），
// 能对它做的事（立即运行、暂停或继续、编辑、删除），下面是运行记录。
// 打开着就算看过了：这个任务没看过的运行一进来就标成看过（之后跑完的也是，人正看着）。
import {
  type DeviceView,
  keys,
  type SessionSummary,
  type TaskView,
  type WorkspaceView,
} from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { nameOf, wireStyle } from '../app/device.ts'
import { reasonOf } from '../app/errors.ts'
import { Back, Close } from '../app/icons.tsx'
import { useKey, useServices } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { errorText, scheduleLine, whenText } from './describe.ts'
import { TaskRuns } from './TaskRuns.tsx'

interface TaskDetailProps {
  deviceId: string
  taskId: string
  onBack(): void
  onClose(): void
  onEdit(): void
  onOpenSession(selection: Selection): void
}

/** 会话的标题，能点就点过去；不在侧栏里了就只写一句 */
function SessionLink({
  deviceId,
  sessionId,
  onOpen,
}: {
  deviceId: string
  sessionId: string
  onOpen(selection: Selection): void
}) {
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const t = useT()
  if (!summary) return <span className="tk-dim">{t('tasks.run.gone')}</span>
  return (
    <button
      type="button"
      className="arch-open tk-link"
      data-act="open-target"
      onClick={() => onOpen({ deviceId, sessionId })}
    >
      {t.text(summary.title)}
    </button>
  )
}

export function TaskDetail({
  deviceId,
  taskId,
  onBack,
  onClose,
  onEdit,
  onOpenSession,
}: TaskDetailProps) {
  const { channel } = useServices()
  const task = useKey<TaskView>(keys.task(deviceId, taskId))
  const device = useKey<DeviceView>(keys.device(deviceId))
  const workspaces = useKey<WorkspaceView[]>(keys.workspaces(deviceId)) ?? []
  const originSession = useKey<SessionSummary>(
    keys.summary(deviceId, task?.origin.kind === 'tool' ? task.origin.threadId : ''),
  )
  const now = useNow()
  const t = useT()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 刚做完的那件事怎么说（立即运行），或者没做成的原因 */
  // kind 写进 data-said，验收按它认是哪一句，不按文字
  const [said, setSaid] = useState<{ text: string; err: boolean; kind: string } | null>(null)
  /** 见过这个任务：之后没了才说“已经不在了”，刚打开还没到的那一下不算 */
  const seen = useRef(false)
  if (task) seen.current = true
  const online = device?.connection === 'online'

  // 看着就算看过了
  const unread = task?.unreadRuns ?? 0
  useEffect(() => {
    if (unread > 0 && online)
      channel.command('tasks.markRead', { deviceId, taskId }).catch(() => {})
  }, [channel, deviceId, taskId, unread, online])

  // Esc 回到列表
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onBack])

  const head = (title: string) => (
    <header className="arch-head">
      <button
        type="button"
        className="ibtn"
        data-act="back"
        title={t('tasks.back')}
        aria-label={t('tasks.back')}
        onClick={onBack}
      >
        <Back />
      </button>
      <div>
        <h1 className="mng-title">
          <span className="ell" data-task-name>
            {title}
          </span>
          {task ? (
            <span className="tk-pill" data-status={task.status}>
              {t(`tasks.status.${task.status}` as MessageKey)}
            </span>
          ) : null}
        </h1>
      </div>
      <button
        type="button"
        className="ibtn"
        title={t('tasks.close')}
        aria-label={t('tasks.close')}
        onClick={onClose}
      >
        <Close />
      </button>
    </header>
  )

  if (!task) {
    return (
      <div className="arch-page tk-page" data-tasks="detail">
        {head(t('tasks.title'))}
        <div className="arch-body">
          <div className="mng-wrap">
            <div className="devp-note">
              {seen.current ? t('tasks.detail.gone') : t('tasks.loading')}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const fail = (error: unknown) =>
    setSaid({ text: t('tasks.failed', { reason: reasonOf(error, t) }), err: true, kind: 'failed' })
  const act = (run: () => Promise<unknown>) => {
    setBusy(true)
    setSaid(null)
    run()
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const runNow = () =>
    act(async () => {
      const { deduplicated } = await channel.command('tasks.runNow', { deviceId, taskId })
      setSaid({
        text: t(deduplicated ? 'tasks.detail.already' : 'tasks.detail.started'),
        err: false,
        kind: deduplicated ? 'already' : 'started',
      })
    })
  const pause = () =>
    act(() =>
      channel.command('tasks.pause', { deviceId, taskId, paused: task.status !== 'paused' }),
    )
  const remove = () => {
    setAsking(false)
    act(async () => {
      await channel.command('tasks.delete', { deviceId, taskId })
      onBack()
    })
  }

  const target = task.target
  const workspace =
    target.kind === 'newThread'
      ? workspaces.find((entry) => entry.id === target.workspaceId)
      : undefined
  const settings =
    target.kind === 'newThread'
      ? [target.settings.model, target.settings.effort, target.settings.permission].filter(
          (value): value is string => value !== null,
        )
      : []
  const running = task.lastRun?.status === 'running' || task.lastRun?.status === 'queued'
  const locked = !online || busy

  return (
    <div className="arch-page tk-page" style={wireStyle(device?.wire)} data-tasks="detail">
      {head(task.name)}
      <div className="arch-body">
        <div className="mng-wrap">
          <section className="mng-sec" data-sec="task">
            <div className="mng-sec-head">
              <h2>{t('tasks.detail.info')}</h2>
              <span className="grow" />
              {asking ? (
                <span className="devp-acts">
                  <span className="devp-ask">{t('tasks.detail.deleteAsk')}</span>
                  <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
                    {t('permission.confirm.no')}
                  </button>
                  <button
                    type="button"
                    className="btn danger"
                    data-act="delete-yes"
                    onClick={remove}
                  >
                    {t('tasks.detail.delete')}
                  </button>
                </span>
              ) : (
                <span className="devp-acts">
                  <button
                    type="button"
                    className="btn"
                    data-act="run-now"
                    disabled={locked}
                    title={running ? t('tasks.detail.running') : undefined}
                    onClick={runNow}
                  >
                    {t('tasks.detail.runNow')}
                  </button>
                  {task.status !== 'completed' ? (
                    <button
                      type="button"
                      className="btn ghost"
                      data-act="pause"
                      disabled={locked}
                      onClick={pause}
                    >
                      {t(task.status === 'paused' ? 'tasks.detail.resume' : 'tasks.detail.pause')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn ghost"
                    data-act="edit"
                    disabled={locked}
                    onClick={onEdit}
                  >
                    {t('tasks.detail.edit')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    data-act="delete"
                    disabled={locked}
                    onClick={() => setAsking(true)}
                  >
                    {t('tasks.detail.delete')}
                  </button>
                </span>
              )}
            </div>
            {asking ? <div className="devp-note">{t('tasks.detail.deleteNote')}</div> : null}
            {!online ? <div className="devp-note">{t('tasks.detail.offline')}</div> : null}
            {said ? (
              <div
                className={said.err ? 'devp-note err' : 'devp-note'}
                role="status"
                data-said={said.kind}
              >
                {said.text}
              </div>
            ) : null}
            <dl className="devp-facts tk-facts">
              <div>
                <dt>{t('tasks.detail.schedule')}</dt>
                <dd>{scheduleLine(task, t, undefined, now)}</dd>
              </div>
              <div>
                <dt>{t('tasks.detail.next')}</dt>
                <dd>
                  {task.nextRunAt !== null
                    ? whenText(task.nextRunAt, now, t)
                    : task.status === 'paused'
                      ? t('tasks.status.paused')
                      : t('tasks.row.noNext')}
                </dd>
              </div>
              <div>
                <dt>{t('tasks.detail.target')}</dt>
                <dd>
                  {target.kind === 'thread' ? (
                    <>
                      {t('tasks.detail.inThread')}{' '}
                      <SessionLink
                        deviceId={deviceId}
                        sessionId={target.threadId}
                        onOpen={onOpenSession}
                      />
                    </>
                  ) : (
                    t('tasks.detail.newThread')
                  )}
                </dd>
              </div>
              {target.kind === 'newThread' ? (
                <div>
                  <dt>{t('tasks.detail.where')}</dt>
                  <dd>
                    {device ? `${t.text(device.name)} · ` : ''}
                    {workspace ? `${workspace.name} · ` : ''}
                    <span className="mono">{target.cwd}</span>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{t('tasks.detail.harness')}</dt>
                <dd>{nameOf(device, target.harness)}</dd>
              </div>
              {target.kind === 'newThread' ? (
                <div>
                  <dt>{t('tasks.detail.model')}</dt>
                  <dd>{settings.length > 0 ? settings.join(' · ') : t('tasks.detail.defaults')}</dd>
                </div>
              ) : null}
              <div>
                <dt>{t('tasks.detail.origin')}</dt>
                <dd>
                  {task.origin.kind === 'client'
                    ? t('tasks.detail.origin.client')
                    : originSession
                      ? t('tasks.detail.origin.tool', { title: t.text(originSession.title) })
                      : t('tasks.detail.origin.toolGone')}
                  {' · '}
                  {t('tasks.detail.created', { when: whenText(task.createdAt, now, t) })}
                </dd>
              </div>
              {task.lastError ? (
                <div>
                  <dt>{t('tasks.detail.lastError')}</dt>
                  <dd className="tk-err">{errorText(task.lastError, t)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="tk-prompt-head">{t('tasks.detail.prompt')}</div>
            <pre className="tk-prompt">{task.prompt}</pre>
          </section>
          <TaskRuns deviceId={deviceId} taskId={taskId} onOpenSession={onOpenSession} />
        </div>
      </div>
    </div>
  )
}
