// 手机端自己的文案：飞书。大部分句子用桌面界面的 feishu.*（packages/ui/src/i18n/zh-CN-feishu.ts），
// 这里只放手机上才有的。键加前缀 "mfs."，中英文各一份。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'mfs.secretDesktop': '更换 App Secret 请在桌面端操作。',
  'mfs.manualDesktop': '已有应用请在桌面端填写 App ID 与 App Secret。',
  'mfs.unset': '未选择',
  'mfs.members': '成员',
  'mfs.records': '记录',
} satisfies Record<string, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'mfs.secretDesktop': 'Replace the App Secret on desktop.',
  'mfs.manualDesktop': 'To use an existing app, enter its App ID and App Secret on desktop.',
  'mfs.unset': 'Not chosen',
  'mfs.members': 'Members',
  'mfs.records': 'Records',
}
