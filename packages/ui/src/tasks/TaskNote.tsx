// 会话顶上那一条：这个会话是哪个定时任务的哪一次运行跑出来的，或者有哪个任务到点在这里接着发。
// 点“去看任务”进那个任务的详情。打开这个会话就算看过了那一次运行（核心在订阅会话时标）。
import { keys, type SessionSummary, type TaskView } from '@litch/core'
import { requestTasks } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useNow } from '../app/clock.ts'
import { useKey } from '../app/services.tsx'
import { triggerText, whenText } from './describe.ts'

export function TaskNote({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const mark = summary?.task ?? null
  const task = useKey<TaskView>(keys.task(deviceId, mark?.taskId ?? ''))
  const now = useNow()
  const t = useT()
  if (!mark) return null
  const text = !task
    ? t('tasks.note.unknown')
    : mark.kind === 'run'
      ? t('tasks.note.run', {
          name: task.name,
          when: whenText(mark.scheduledFor, now, t),
          trigger: triggerText(mark.trigger, t),
        })
      : t('tasks.note.target', { name: task.name })
  return (
    <div className="forked-from task-note" data-task-note={mark.kind} data-task={mark.taskId}>
      <span>{text}</span>
      {task ? (
        <button
          type="button"
          className="forked-link"
          data-act="open-task"
          onClick={() => requestTasks({ view: 'detail', deviceId, taskId: mark.taskId })}
        >
          {t('tasks.note.open')}
        </button>
      ) : null}
    </div>
  )
}
