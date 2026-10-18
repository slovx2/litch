// 表单底下那一句“下一次在…”：用和设备进程同一份日程算法（协议包的 task-schedule，经核心包导出）。
// 时区选的是“设备的”时，按设备报的时区算（runtime/info 的 device.timezone）；旧版设备服务不报，
// 就按这台电脑的估一个，并说明是估的。
import { isTaskTimeZone, nextTaskRun, validateTaskSchedule } from '@litch/core'
import { viewerZone } from './describe.ts'
import { scheduleOf, type TaskForm } from './form.ts'

export type Preview =
  /** 下一次的时间（毫秒）；estimated：时区是按这台电脑估的 */
  | { kind: 'at'; ms: number; estimated: boolean }
  /** 这个日程不会再跑了（一次性的、时间已经过了） */
  | { kind: 'none' }
  /** 算不出来：日程还没填对，或者算法眼下用不了 */
  | { kind: 'unknown' }

export function previewOf(form: TaskForm, now: number, deviceZone: string | null = null): Preview {
  const zone = form.timezone ?? deviceZone ?? viewerZone()
  try {
    const schedule = scheduleOf(form)
    if (validateTaskSchedule(schedule, zone) !== null) return { kind: 'unknown' }
    const seconds = Math.floor(now / 1000)
    const next = nextTaskRun(schedule, zone, seconds, seconds)
    if (next === null) return { kind: 'none' }
    return { kind: 'at', ms: next * 1000, estimated: form.timezone === null && deviceZone === null }
  } catch {
    return { kind: 'unknown' }
  }
}

/** 这台电脑认不认识这个时区名。算法用不了的时候不拦（交给设备那一头去查） */
export function zoneKnown(zone: string): boolean {
  try {
    return isTaskTimeZone(zone)
  } catch {
    return true
  }
}
