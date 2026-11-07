// 手机端自己的文案：首页的置顶和本机分组。大部分句子用桌面界面的 local.*、sidebar.*，这里只放手机上才有的几句
// （手机不拖放，靠长按）。键加前缀 "organizer."，中英文各一份，键必须一致（en 的类型约束保证）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'organizer.count': '{count} 个对话',
  'organizer.empty': '长按对话，选择“加入本机分组”',
  'organizer.blocked': '本机分组文件无法读取或来自更新版本，暂时只读。',
  'organizer.up': '上移',
  'organizer.down': '下移',
  'organizer.open': '打开设备会话',
  'organizer.leave': '移出本组',
} satisfies Record<string, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'organizer.count': '{count} chats',
  'organizer.empty': 'Long-press a chat and choose “Add to local group”',
  'organizer.blocked':
    'The local groups file can’t be read or was written by a newer version. It’s read-only for now.',
  'organizer.up': 'Move up',
  'organizer.down': 'Move down',
  'organizer.open': 'Open device sessions',
  'organizer.leave': 'Remove from group',
}
