// 手机端自己的文案：定时任务线。大部分句子用桌面界面的 tasks.*（packages/ui/src/i18n/zh-CN-tasks.ts，
// 日程和时间的说法也在那边的 describe.ts 里），这里只放手机上才有的几句。键加前缀 "timed."（避开 tasks.），
// 中英文各一份，键必须一致（en 的类型约束保证）；单测检查不和桌面界面撞名。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'timed.entry.count': '{count} 个任务',
  'timed.entry.none': '到点由设备自己跑，手机断开也照样跑',
  'timed.unread': '{count} 次没看',
  'timed.row': '{label} {value}',
  'timed.mark': '定时',
  'timed.runs.markRead': '全部标成看过',
  'timed.date': '日期（年-月-日）',
  'timed.monthDay.note': '没有这一天的月份（比如 31 号）在当月最后一天跑',
  'timed.preview.estimated': '下一次在 {when}（按手机的时区估算，设备的时区可能不一样）',
  'timed.zone.device': '设备的时区（{zone}）',
  'timed.zone.local': '{zone}（手机所在）',
  'timed.zone.task': '{zone}（任务原来的）',
} satisfies Record<string, Entry>

const plural = (one: string, many: string) => (args: Record<string, string | number>) =>
  (Number(args.count) === 1 ? one : many).replace('{count}', String(args.count))

export const en: Record<keyof typeof zhCN, Entry> = {
  'timed.entry.count': plural('{count} task', '{count} tasks'),
  'timed.entry.none': 'Run by the device on schedule, even while your phone is away',
  'timed.unread': '{count} unseen',
  'timed.row': '{label}: {value}',
  'timed.mark': 'Scheduled',
  'timed.runs.markRead': 'Mark all as seen',
  'timed.date': 'Date (YYYY-MM-DD)',
  'timed.monthDay.note': 'Months without that day (like the 31st) run on their last day',
  'timed.preview.estimated':
    'Next run {when} (estimated in this phone’s time zone; the device’s may differ)',
  'timed.zone.device': 'The device’s time zone ({zone})',
  'timed.zone.local': '{zone} (this phone)',
  'timed.zone.task': '{zone} (the task’s)',
}
