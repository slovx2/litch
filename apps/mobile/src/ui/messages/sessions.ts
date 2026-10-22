// 手机端自己的文案：会话列表线：会话列表、文件浏览、设置页。键加前缀 "sessions."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'sessions.new': '新会话',
  'sessions.newHere': '在这里新建会话',
  'sessions.more': '更多',
  'sessions.files': '浏览文件',
  'sessions.empty': '此设备暂无会话',
  'sessions.empty.note': '点击右上角的“＋”新建会话。',
  'sessions.banner': '{state}：{note}',
  'sessions.failed.dismiss': '点击关闭',
  'sessions.move.none': '没有其他可移入的项目',
  'sessions.files.title': '文件',
  'sessions.files.up': '上一层',
  'sessions.files.line': '第 {n} 行',
  'sessions.files.notFound': '没有这一行（文件共 {n} 行）',
  'sessions.settings.lang.system': '跟随系统',
  'sessions.settings.dev': '开发者',
  'sessions.settings.boot': '启动方式',
  'sessions.settings.boot.note': '切换后核心会重新启动，已连接的设备将断开。',
  'sessions.settings.boot.stored': '正式（已保存的设备）',
  'sessions.settings.boot.mock': '模拟核心',
  'sessions.settings.boot.fixture': '测试夹具',
  'sessions.settings.mode': '当前：{mode}',
} satisfies Record<`sessions.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'sessions.new': 'New session',
  'sessions.newHere': 'New session here',
  'sessions.more': 'More',
  'sessions.files': 'Browse files',
  'sessions.empty': 'No sessions on this device',
  'sessions.empty.note': 'Tap “＋” at the top right to start one.',
  'sessions.banner': '{state}: {note}',
  'sessions.failed.dismiss': 'Tap to dismiss',
  'sessions.move.none': 'No other project to move to',
  'sessions.files.title': 'Files',
  'sessions.files.up': 'Up one level',
  'sessions.files.line': 'Line {n}',
  'sessions.files.notFound': 'No such line (the file has {n} lines)',
  'sessions.settings.lang.system': 'Follow system',
  'sessions.settings.dev': 'Developer',
  'sessions.settings.boot': 'Startup',
  'sessions.settings.boot.note':
    'Changing this restarts the core. Connected devices will disconnect.',
  'sessions.settings.boot.stored': 'Normal (saved devices)',
  'sessions.settings.boot.mock': 'Mock core',
  'sessions.settings.boot.fixture': 'Test fixture',
  'sessions.settings.mode': 'Current: {mode}',
}
