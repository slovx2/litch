// 侧面板的“后台任务”页：眼前这个会话回合结束后还在跑的、这次运行里结束过的工作。
// 运行中在上、已结束在下，每行只有名称（一行截断，悬停看全文）、用时、状态；不展开输出和详情，没有停止按钮。
// 跑完会不会自动接着做写在运行中那一组的组头右边（派生出来的不知道，就不写）。没有在跑的时候也能打开。
import type { BackgroundTaskKind, BackgroundTaskView } from '@litch/core'
import { memo } from 'react'
import { useT } from '../app/appearance.ts'
import { useElapsed } from '../app/clock.ts'
import { duration } from '../app/format.ts'
import { Icon, type IconName } from '../app/icons.tsx'
import type { SideTabProps } from '../side/tabs.ts'
import { elapsedOf, useSessionBackground } from './state.ts'

const ICON: Record<BackgroundTaskKind, IconName> = {
  shell: 'term',
  agent: 'agents',
  monitor: 'eye',
  workflow: 'tree',
  remote: 'globe',
  other: 'tool',
}

export function BackgroundTab({ place }: SideTabProps) {
  const t = useT()
  const background = useSessionBackground(place.deviceId, place.sessionId)
  if (!place.sessionId) return <div className="side-none dim">{t('background.pick')}</div>
  const tasks = background?.tasks ?? []
  if (tasks.length === 0)
    return (
      <div className="side-none dim" data-background-empty>
        {t('background.noneEver')}
      </div>
    )
  const running = tasks.filter((task) => task.status === 'running')
  const ended = tasks.filter((task) => task.status !== 'running')
  const wakes = background?.wakesOnFinish ?? null
  return (
    <div className="bg-panel" data-session={place.sessionId}>
      {running.length > 0 ? (
        <>
          <div className="bg-group" data-group="running">
            <span>{t('background.running')}</span>
            <b>{running.length}</b>
            {wakes === null ? null : (
              <span className="bg-wakes dim">
                {t(wakes ? 'background.wakes' : 'background.noWake')}
              </span>
            )}
          </div>
          {running.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </>
      ) : (
        <div className="bg-empty">{t('background.none')}</div>
      )}
      {ended.length > 0 ? (
        <>
          <div className="bg-group" data-group="ended">
            <span>{t('background.ended')}</span>
            <b>{ended.length}</b>
          </div>
          {ended.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </>
      ) : null}
    </div>
  )
}

const TaskRow = memo(function TaskRow({ task }: { task: BackgroundTaskView }) {
  const t = useT()
  // 在跑的一秒一秒地走；结束了的是定数
  const ticking = useElapsed(task.status === 'running' ? task.startedAt : null)
  const elapsed = task.status === 'running' ? ticking : elapsedOf(task, Date.now())
  return (
    <div className="bg-row" data-task={task.id} data-status={task.status} title={task.title}>
      <span className="bg-kind" role="img" aria-label={t(`background.kind.${task.kind}`)}>
        <Icon name={ICON[task.kind]} small />
      </span>
      <span className="t ell">{task.title}</span>
      <span className="meta">
        {elapsed === null ? null : <span>{duration(elapsed, t)}</span>}
        <span className={`bg-st ${task.status}`}>{t(`background.status.${task.status}`)}</span>
      </span>
    </div>
  )
})
