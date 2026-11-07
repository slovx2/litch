// 手机端自己的文案：输入线：输入区、审批与提问、新会话。键加前缀 "compose."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  // 桌面端那两句提到了回车和 Shift，手机上回车是换行、发送靠按钮
  'compose.placeholder': '输入消息',
  'compose.placeholder.steer': '插入当前回合…',
  'compose.placeholder.queue': '排队发送…',
  'compose.pendingShort': '含 {n} 条',
  'compose.addImage': '添加图片',
  'compose.image.open': '无法打开系统相册。请重试，或重启应用后重新选择。',
  'compose.image.read': '无法读取所选图片。请在系统照片中下载原图后重试，或选择其他图片。',
  'compose.context': '上下文',
  'compose.ring': '上下文已用 {n}%',
  'compose.more': '添加与对话设置',
  'compose.more.plan': '添加与对话设置，计划模式已开',
  'compose.more.title': '添加与设置',
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
  'compose.placeholder.steer': 'Add to this turn…',
  'compose.placeholder.queue': 'Queue a message…',
  'compose.pendingShort': '+{n} pending',
  'compose.addImage': 'Add images',
  'compose.image.open':
    'Could not open the photo picker. Try again, or restart the app and select again.',
  'compose.image.read':
    'Could not read the selected image. Download the original in Photos and try again, or choose another image.',
  'compose.context': 'Context',
  'compose.ring': 'Context {n}% used',
  'compose.more': 'Add and conversation settings',
  'compose.more.plan': 'Add and conversation settings, plan mode on',
  'compose.more.title': 'Add and settings',
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
