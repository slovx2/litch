// 定时任务的日程怎么算：校验、下一次在什么时候、一段时间里错过了几次。
// 设备进程按它排日程，客户端按它在表单里预览“下一次”。只用标准库（Intl 算时区），不引别的包：
// 设备进程没有自己的 node_modules，移动端的 Hermes 也要能跑。
// 时间一律是 Unix 秒。日程的含义见 device-tasks.mts 的 TaskSchedule。
import type { TaskSchedule } from './device-tasks.mjs'

/** 相邻两次运行至少隔这么多分钟。interval 的 minutes 不能比它小；别的日程算出来更密的也按它拉开 */
export const MIN_TASK_INTERVAL_MINUTES = 5

/** 校验不过时说哪个字段、为什么 */
export interface TaskScheduleProblem {
  /** schedule、schedule.time、schedule.days、timezone 这样的路径 */
  field: string
  /** 英文的一句话，给人和模型看 */
  message: string
}

/** 是不是这台机器认识的 IANA 时区名 */
export function isTaskTimeZone(name: string): boolean {
  void name
  throw new Error('task-schedule: 还没实现')
}

/** 这台机器所在的时区（IANA 名）；认不出来是 UTC */
export function localTaskTimeZone(): string {
  throw new Error('task-schedule: 还没实现')
}

/** 日程和时区合不合法。合法是 null。schedule 可以是任意值（来自线上） */
export function validateTaskSchedule(
  schedule: unknown,
  timezone: unknown,
): TaskScheduleProblem | null {
  void schedule
  void timezone
  throw new Error('task-schedule: 还没实现')
}

/**
 * 严格晚于 after 的下一次运行时间；以后不会再有（once 已经过了）是 null。
 * anchor：日程从什么时候起算（任务建好、或者这条日程改好的时间）。interval 从它起每隔 minutes 一次；
 * once 早于 anchor 的算已经过了；别的日程只用它保证不早于它。
 * 调用方保证 schedule、timezone 已经校验过。
 */
export function nextTaskRun(
  schedule: TaskSchedule,
  timezone: string,
  after: number,
  anchor: number,
): number | null {
  void schedule
  void timezone
  void after
  void anchor
  throw new Error('task-schedule: 还没实现')
}

/**
 * (from, to] 之间有几个运行时间点，最多数到 limit 就停（错过很久时不必数完）。
 * 设备进程用它算“这次合并了几次”。anchor 同 nextTaskRun。
 */
export function countTaskRuns(
  schedule: TaskSchedule,
  timezone: string,
  from: number,
  to: number,
  anchor: number,
  limit = 1000,
): number {
  void schedule
  void timezone
  void from
  void to
  void anchor
  void limit
  throw new Error('task-schedule: 还没实现')
}
