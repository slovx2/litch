// 手机端自己的文案：经理。大部分句子用桌面界面的 manager.*（packages/ui/src/i18n/zh-CN-manager.ts），
// 这里只放手机上才有的几句。键加前缀 "mgr."（避开 manager.），中英文各一份。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'mgr.entry.none': '没有进行中的经理',
  'mgr.entry.active': '{count} 位经理进行中',
  'mgr.empty.detail': '经理在桌面端新建',
  'mgr.activity.more': '显示更多动态',
  'mgr.answer.empty': '先选一项或写补充说明',
  'mgr.answer.note': '先写补充说明',
} satisfies Record<string, Entry>

const plural = (one: string, many: string) => (args: Record<string, string | number>) =>
  (Number(args.count) === 1 ? one : many).replace('{count}', String(args.count))

export const en: Record<keyof typeof zhCN, Entry> = {
  'mgr.entry.none': 'No active managers',
  'mgr.entry.active': plural('{count} active manager', '{count} active managers'),
  'mgr.empty.detail': 'Create managers in the desktop app.',
  'mgr.activity.more': 'Show more activity',
  'mgr.answer.empty': 'Choose an option or add a note first',
  'mgr.answer.note': 'Add a note first',
}
