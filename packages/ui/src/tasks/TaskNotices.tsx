// 定时任务跑完了发系统通知：失败的一定发，成功的看设置（默认不发）。回合停在审批、提问上等人时也发
// （onTaskRunAsking：核心连着时看着新来的），到时限没人答设备会替人拒绝。只在桌面外壳里有，普通浏览器里什么都不做。
// 什么时候算“跑完了”由数据副本定（onTaskRunFinished：一次运行头一回以结束的样子、未读地到）；
// 点通知回到那次运行跑在的会话（等人处理的在那里答），还没建出会话就失败了的去那个任务的详情。
import { type DeviceView, keys, type TaskRunView } from '@litch/core'
import { useEffect, useRef } from 'react'
import type { Selection } from '../app/App.tsx'
import { requestTasks } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { useServices } from '../app/services.tsx'
import { askLine, errorText, runStatusText } from './describe.ts'
import { notifySuccess } from './notify-pref.ts'

/** 记着最近发过的几条，点了能找回是哪一次运行 */
const KEEP = 50

export function TaskNotices({ onOpen }: { onOpen(selection: Selection): void }) {
  const { replica } = useServices()
  const t = useT()
  const said = useRef(t)
  said.current = t
  const open = useRef(onOpen)
  open.current = onOpen
  const sent = useRef(new Map<string, TaskRunView>())

  useEffect(() => {
    const shell = window.litchShell
    if (!shell?.notify) return
    const notify = shell.notify.bind(shell)
    const remember = (run: TaskRunView) => {
      const list = sent.current
      list.set(run.id, run)
      if (list.size > KEEP) list.delete(list.keys().next().value as string)
    }
    const stopAsking = replica.onTaskRunAsking((run, task, asking) => {
      const first = asking[0]
      if (!first) return
      const t = said.current
      const device = replica.store.get<DeviceView>(keys.device(run.deviceId))
      remember(run)
      notify({
        id: run.id,
        title: t('tasks.notice.asking', { name: task?.name ?? t('tasks.note.unknown') }),
        body: t('tasks.notice.askingBody', {
          device: device ? t.text(device.name) : run.deviceId,
          line: askLine(first, t),
          minutes: Math.max(1, Math.ceil((first.declineAt - Date.now()) / 60_000)),
        }),
      })
    })
    const stopFinished = replica.onTaskRunFinished((run, task) => {
      const failed = run.status === 'failed'
      if (!failed && !(run.status === 'succeeded' && notifySuccess())) return
      const t = said.current
      const device = replica.store.get<DeviceView>(keys.device(run.deviceId))
      const name = task?.name ?? t('tasks.note.unknown')
      const text = failed
        ? run.error
          ? errorText(run.error, t)
          : runStatusText(run.status, t)
        : (run.summary ?? runStatusText(run.status, t))
      remember(run)
      notify({
        id: run.id,
        title: t(failed ? 'tasks.notice.failed' : 'tasks.notice.succeeded', { name }),
        body: t('tasks.notice.body', {
          device: device ? t.text(device.name) : run.deviceId,
          text: text.replace(/\s+/g, ' ').trim(),
        }),
      })
    })
    return () => {
      stopAsking()
      stopFinished()
    }
  }, [replica])

  useEffect(
    () =>
      window.litchShell?.onNotifyClick?.((id) => {
        const run = sent.current.get(id)
        if (!run) return
        if (run.threadId && replica.store.get(keys.summary(run.deviceId, run.threadId)))
          open.current({ deviceId: run.deviceId, sessionId: run.threadId })
        else requestTasks({ view: 'detail', deviceId: run.deviceId, taskId: run.taskId })
      }),
    [replica],
  )
  return null
}
