// 手机端自己的文案：定时任务线。大部分句子用桌面界面的 tasks.*（packages/ui/src/i18n/zh-CN-tasks.ts，
// 日程和时间的说法也在那边的 describe.ts 里），这里只放手机上才有的几句。键加前缀 "timed."（避开 tasks.），
// 中英文各一份，键必须一致（en 的类型约束保证）；单测检查不和桌面界面撞名。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'timed.entry.count': '{count} 个任务',
  'timed.entry.none': '由设备按时运行，手机断开时也会运行',
  'timed.unread': '{count} 次未读',
  'timed.row': '{label} {value}',
  'timed.mark': '定时',
  'timed.runs.markRead': '全部标为已读',
  'timed.date': '日期（年-月-日）',
  'timed.monthDay.note': '没有该日期的月份（如 31 日）在当月最后一天运行',
  'timed.preview.estimated': '下次运行：{when}（按手机时区估算，可能与设备时区不同）',
  'timed.zone.device': '设备时区（{zone}）',
  'timed.zone.local': '{zone}（手机）',
  'timed.zone.task': '{zone}（任务原时区）',
} satisfies Record<string, Entry>

const plural = (one: string, many: string) => (args: Record<string, string | number>) =>
  (Number(args.count) === 1 ? one : many).replace('{count}', String(args.count))

export const en: Record<keyof typeof zhCN, Entry> = {
  'timed.entry.count': plural('{count} task', '{count} tasks'),
  'timed.entry.none': 'Run by the device on schedule, even when your phone is disconnected',
  'timed.unread': '{count} unread',
  'timed.row': '{label}: {value}',
  'timed.mark': 'Scheduled',
  'timed.runs.markRead': 'Mark all as read',
  'timed.date': 'Date (YYYY-MM-DD)',
  'timed.monthDay.note': 'Months without that day (like the 31st) run on their last day',
  'timed.preview.estimated':
    'Next run {when} (estimated in this phone’s time zone; the device’s may differ)',
  'timed.zone.device': 'Device time zone ({zone})',
  'timed.zone.local': '{zone} (this phone)',
  'timed.zone.task': '{zone} (task’s original)',
}
