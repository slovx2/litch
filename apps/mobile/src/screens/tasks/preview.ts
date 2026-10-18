// 表单里“下一次在…”的预览：表单读成日程（schedule.ts），交给协议包的日程函数校验、算下一次。
// 设备上按同一套函数排日程，所以预览和设备上实际的一致（时区数据库不同的极端情况除外）。

import type { TaskSchedule } from '../../../../../packages/protocol/src/device-tasks.mjs'
import {
  MIN_TASK_INTERVAL_MINUTES,
  nextTaskRun,
  validateTaskSchedule,
} from '../../../../../packages/protocol/src/task-schedule.mjs'
import { type FormProblem, readForm, type ScheduleForm } from './schedule'

export type Preview =
  /** 下一次在 at（Unix 秒） */
  | { kind: 'next'; at: number; schedule: TaskSchedule }
  /** 合法，但以后不会再跑（一次性的时间已经过了） */
  | { kind: 'never'; schedule: TaskSchedule }
  /** 表单上哪一栏写法不对 */
  | ({ kind: 'form' } & FormProblem)
  /** 算不出来（日程函数出了意外）：不拦着交，设备那边还会再校验一遍 */
  | { kind: 'unknown'; schedule: TaskSchedule }
  /** 协议的校验没过：英文的一句话（来自 validateTaskSchedule） */
  | { kind: 'invalid'; field: string; message: string }

export function previewOf(form: ScheduleForm, timezone: string, nowSeconds: number): Preview {
  const read = readForm(form, MIN_TASK_INTERVAL_MINUTES)
  if (!read.ok) {
    const { ok: _ok, ...problem } = read
    return { kind: 'form', ...problem }
  }
  const { schedule } = read
  try {
    const problem = validateTaskSchedule(schedule, timezone)
    if (problem) return { kind: 'invalid', field: problem.field, message: problem.message }
    // 新建（或者改了日程）的锚点就是现在
    const at = nextTaskRun(schedule, timezone, nowSeconds, nowSeconds)
    return at === null ? { kind: 'never', schedule } : { kind: 'next', at, schedule }
  } catch {
    return { kind: 'unknown', schedule }
  }
}
