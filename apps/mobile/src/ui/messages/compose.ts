// 手机端自己的文案：输入线：输入区、审批与提问、新会话。键加前缀 "compose."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  // 桌面端那两句提到了回车和 Shift，手机上回车是换行、发送靠按钮
  'compose.placeholder': '输入消息',
  'compose.placeholderRunning': '回合进行中，新消息将排队发送',
  'compose.addImage': '添加图片',
  'compose.context': '上下文',
  'compose.menu.terminal': '终端',
  'compose.menu.diff': '差异',
  'compose.menu.files': '文件',
  'compose.archive.title': '归档此会话？',
  'compose.archive.note': '会话将从列表中移除，内容仍保留在设备上，可在“已归档”中恢复。',
  'compose.new.where': '位置',
  'compose.new.otherDir': '其他目录…',
  'compose.new.dir': '目录',
  'compose.new.dirTitle': '选择目录',
  'compose.new.dirPlaceholder': '设备上的完整路径，例如 /home/me/project',
  'compose.new.settings': '设置',
  'compose.new.placeholder': '要做什么？',
} satisfies Record<`compose.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'compose.placeholder': 'Message',
  'compose.placeholderRunning': 'A turn is running. New messages are queued.',
  'compose.addImage': 'Add images',
  'compose.context': 'Context',
  'compose.menu.terminal': 'Terminal',
  'compose.menu.diff': 'Changes',
  'compose.menu.files': 'Files',
  'compose.archive.title': 'Archive this session?',
  'compose.archive.note': 'It leaves the list but stays on the device. Restore it from Archived.',
  'compose.new.where': 'Location',
  'compose.new.otherDir': 'Another folder…',
  'compose.new.dir': 'Folder',
  'compose.new.dirTitle': 'Choose a folder',
  'compose.new.dirPlaceholder': 'Full path on the device, e.g. /home/me/project',
  'compose.new.settings': 'Settings',
  'compose.new.placeholder': 'What should it do?',
}
