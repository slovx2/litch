// 定时任务：占着对话区的一整页。列表按设备分开，点一行进详情；新建、编辑是同一页里的表单。
// 任务存在设备上，数据副本一直订着每台设备的任务（keys.taskIds / keys.task），这一页只是看和发命令。
import { type DeviceView, keys, type TaskView } from '@litch/core'
import { useCallback, useEffect, useState } from 'react'
import type { Selection } from '../app/App.tsx'
import type { TasksRoute } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { wireStyle } from '../app/device.ts'
import { Close, Forward, Plus } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import type { MessageKey } from '../i18n/index.ts'
import { runStatusText, runTone, scheduleLine, waitingAsks, whenText } from './describe.ts'
import { TaskDetail } from './TaskDetail.tsx'
import { TaskFormPage } from './TaskForm.tsx'
import { useSchedulable } from './useSchedulable.ts'

/** 一行任务：名字、日程的人话、下一次、最近一次怎么样，没看过的有几条。暂停的整行淡下去 */
function TaskRow({
  deviceId,
  taskId,
  onOpen,
}: {
  deviceId: string
  taskId: string
  onOpen(): void
}) {
  const task = useKey<TaskView>(keys.task(deviceId, taskId))
  const now = useNow()
  const t = useT()
  if (!task) return null
  const last = task.lastRun
  const quiet = task.status !== 'active'
  return (
    <li className={quiet ? 'tk-row off' : 'tk-row'} data-task={task.id} data-status={task.status}>
      <button type="button" className="tk-row-btn" onClick={onOpen}>
        <span className="tk-row-main">
          <span className="tk-row-name ell">{task.name}</span>
          <span className="tk-row-sched ell">{scheduleLine(task, t, undefined, now)}</span>
        </span>
        <span className="tk-row-next">
          <span className="tk-row-label">{t('tasks.row.next')}</span>
          <span className="ell">
            {task.status === 'paused'
              ? t('tasks.status.paused')
              : task.nextRunAt !== null
                ? whenText(task.nextRunAt, now, t)
                : t('tasks.row.noNext')}
          </span>
        </span>
        <span className="tk-row-last">
          <span className="tk-row-label">{t('tasks.row.last')}</span>
          {last && waitingAsks(last).length > 0 ? (
            <span className="tk-st ell" data-tone="wait" data-mark="asking">
              <i className="tk-dot" />
              {t('tasks.ask.mark')}
            </span>
          ) : last ? (
            <span className="tk-st ell" data-tone={runTone(last.status)}>
              <i className="tk-dot" />
              {runStatusText(last.status, t)}
              <span className="tk-st-when">
                {whenText(last.finishedAt ?? last.startedAt ?? last.scheduledFor, now, t)}
              </span>
            </span>
          ) : (
            <span className="tk-st ell">{t('tasks.row.never')}</span>
          )}
        </span>
        {task.unreadRuns > 0 ? (
          <span className="tk-badge" title={t('tasks.unread', { count: task.unreadRuns })}>
            {task.unreadRuns}
          </span>
        ) : (
          <span className="tk-badge-gap" />
        )}
        <Forward />
      </button>
    </li>
  )
}

/** 一台设备上的任务。支不支持、连没连上，各说一句 */
function DeviceTasks({ deviceId, onOpen }: { deviceId: string; onOpen(taskId: string): void }) {
  const device = useKey<DeviceView>(keys.device(deviceId))
  const available = useKey<boolean | null>(keys.tasksAvailable(deviceId)) ?? null
  const ids = useKey<string[]>(keys.taskIds(deviceId)) ?? []
  const t = useT()
  if (!device) return null
  const online = device.connection === 'online'
  let note: string | null = null
  if (available === false) note = t('tasks.unsupported' as MessageKey)
  else if (available === null && ids.length === 0) note = t('tasks.unknown')
  else if (!online) note = t('tasks.offline')
  else if (ids.length === 0) note = t('tasks.empty')
  return (
    <section className="arch-dev tk-dev" style={wireStyle(device.wire)} data-device={deviceId}>
      <h2 className="arch-dev-head">
        <i className={online ? 'wire-sq' : 'wire-sq off'} />
        <span>{t.text(device.name)}</span>
        <span className="mono">{device.host}</span>
      </h2>
      {note ? <div className="arch-note">{note}</div> : null}
      {ids.length > 0 ? (
        <ul className="tk-list">
          {ids.map((taskId) => (
            <TaskRow
              key={taskId}
              deviceId={deviceId}
              taskId={taskId}
              onOpen={() => onOpen(taskId)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

interface TasksPageProps {
  /** 一打开就去哪：列表、某个任务的详情、新建 */
  initial: TasksRoute
  onClose(): void
  /** 打开一次运行跑在的那个会话 */
  onOpenSession(selection: Selection): void
}

export function TasksPage({ initial, onClose, onOpenSession }: TasksPageProps) {
  const deviceIds = useKey<string[]>(keys.devices) ?? []
  const unread = useKey<number>(keys.tasksUnread) ?? 0
  const schedulable = useSchedulable()
  const t = useT()
  const [route, setRoute] = useState<TasksRoute>(initial)
  /** 编辑表单关掉之后回哪：从详情进去的回详情 */
  const [editing, setEditing] = useState<{ deviceId: string; taskId: string } | null>(null)
  const toList = useCallback(() => {
    setEditing(null)
    setRoute({ view: 'list' })
  }, [])

  // Esc 回到对话。在详情、表单里的时候 Esc 归它们自己（回到列表）
  const inList = route.view === 'list' && editing === null
  useEffect(() => {
    if (!inList) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [inList, onClose])

  if (editing) {
    return (
      <TaskFormPage
        mode={{ kind: 'edit', ...editing }}
        onDone={(saved) => {
          setEditing(null)
          setRoute(saved ? { view: 'detail', ...saved } : { view: 'detail', ...editing })
        }}
        onClose={onClose}
      />
    )
  }
  if (route.view === 'new') {
    return (
      <TaskFormPage
        mode={{ kind: 'new', deviceId: route.deviceId, threadId: route.threadId }}
        onDone={(saved) => setRoute(saved ? { view: 'detail', ...saved } : { view: 'list' })}
        onClose={onClose}
      />
    )
  }
  if (route.view === 'detail') {
    return (
      <TaskDetail
        key={`${route.deviceId}:${route.taskId}`}
        deviceId={route.deviceId}
        taskId={route.taskId}
        onBack={toList}
        onClose={onClose}
        onEdit={() => setEditing({ deviceId: route.deviceId, taskId: route.taskId })}
        onOpenSession={onOpenSession}
      />
    )
  }

  return (
    <div className="arch-page tk-page" data-tasks="list">
      <header className="arch-head">
        <div>
          <h1>{t('tasks.title')}</h1>
          <p>
            {t('tasks.intro')}
            {unread > 0 ? (
              <span className="tk-head-unread"> {t('tasks.unread', { count: unread })}</span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="btn tk-new"
          data-act="new-task"
          disabled={schedulable.length === 0}
          title={schedulable.length === 0 ? t('tasks.form.noDevice') : undefined}
          onClick={() => setRoute({ view: 'new', deviceId: null, threadId: null })}
        >
          <Plus />
          {t('tasks.new')}
        </button>
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
      <div className="arch-body">
        {deviceIds.map((deviceId) => (
          <DeviceTasks
            key={deviceId}
            deviceId={deviceId}
            onOpen={(taskId) => setRoute({ view: 'detail', deviceId, taskId })}
          />
        ))}
      </div>
    </div>
  )
}
