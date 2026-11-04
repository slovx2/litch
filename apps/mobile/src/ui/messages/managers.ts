// 手机端自己的文案：经理。大部分句子用桌面界面的 manager.*（packages/ui/src/i18n/zh-CN-manager.ts），
// 这里只放手机上才有的几句。键加前缀 "mgr."（避开 manager.），中英文各一份。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'mgr.entry.none': '没有进行中的经理',
  'mgr.entry.active': '{count} 位经理进行中',
  'mgr.empty.detail': '经理在桌面端新建',
  'mgr.answer.empty': '先选一项或写补充说明',
  'mgr.answer.note': '先写补充说明',
  'mgr.ignored.show': '展开详情',
  'mgr.ignored.hide': '收起详情',
  'mgr.discussion.full': '展开到全屏',
  'mgr.discussion.half': '收回半屏',
  'mgr.back': '回到经理 {name}',
  'mgr.tab.chat': '对话',
  'mgr.tab.lines': '工作线',
  'mgr.tab.chatRunning': '对话 · 经理运行中',
  'mgr.tab.chatUnread': '对话 · 有新回复',
  'mgr.tab.linesRunning': '{count} 条运行中',
  'mgr.tab.linesWaiting': '有工作线等你',
  'mgr.lines.none': '经理还没开工作线',
  'mgr.lines.ended': '已结束 {count}',
  'mgr.lines.unverified': '没验 {count}',
  'mgr.lines.background': '后台任务运行中',
  'mgr.items.count': '经理事项 {count}',
  'mgr.sheet.console': '在控制台打开',
  'mgr.sheet.close': '关闭议题卡',
  'mgr.tag': '经理',
} satisfies Record<string, Entry>

const plural = (one: string, many: string) => (args: Record<string, string | number>) =>
  (Number(args.count) === 1 ? one : many).replace('{count}', String(args.count))

export const en: Record<keyof typeof zhCN, Entry> = {
  'mgr.entry.none': 'No active managers',
  'mgr.entry.active': plural('{count} active manager', '{count} active managers'),
  'mgr.empty.detail': 'Create managers in the desktop app.',
  'mgr.answer.empty': 'Choose an option or add a note first',
  'mgr.answer.note': 'Add a note first',
  'mgr.ignored.show': 'Show details',
  'mgr.ignored.hide': 'Hide details',
  'mgr.discussion.full': 'Expand to full screen',
  'mgr.discussion.half': 'Shrink to half screen',
  'mgr.back': 'Back to manager {name}',
  'mgr.tab.chat': 'Chat',
  'mgr.tab.lines': 'Lines',
  'mgr.tab.chatRunning': 'Chat · manager running',
  'mgr.tab.chatUnread': 'Chat · new reply',
  'mgr.tab.linesRunning': '{count} running',
  'mgr.tab.linesWaiting': 'A work line needs you',
  'mgr.lines.none': 'No work lines yet',
  'mgr.lines.ended': 'Ended {count}',
  'mgr.lines.unverified': '{count} unverified',
  'mgr.lines.background': 'Background tasks running',
  'mgr.items.count': plural('{count} manager item', '{count} manager items'),
  'mgr.sheet.console': 'Open in Console',
  'mgr.sheet.close': 'Close issue card',
  'mgr.tag': 'Manager',
}
