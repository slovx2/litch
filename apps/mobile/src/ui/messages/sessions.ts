// 手机端自己的文案：会话列表线：会话列表、文件浏览、设置页。键加前缀 "sessions."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'sessions.new': '新会话',
  'sessions.newHere': '在这里新建会话',
  'sessions.more': '更多',
  'sessions.files': '浏览文件',
  'sessions.empty': '这台设备上还没有会话',
  'sessions.empty.note': '点右上角的“＋”新建一个。',
  'sessions.banner': '{state}：{note}',
  'sessions.failed.dismiss': '点一下关掉',
  'sessions.move.none': '没有别的项目可移',
  'sessions.files.title': '文件',
  'sessions.files.up': '上一层',
  'sessions.files.line': '第 {n} 行',
  'sessions.files.notFound': '没有这一行（文件共 {n} 行）',
  'sessions.settings.lang.system': '跟随系统',
  'sessions.settings.lang.note': '跟随系统时，按手机的语言选中文或英文。',
  'sessions.settings.theme.note': '跟随系统时，系统换了深浅，这里一起换。',
  'sessions.settings.dev': '开发者',
  'sessions.settings.boot': '启动方式',
  'sessions.settings.boot.note': '换了之后核心会重新装一次，正在连的设备会断开。',
  'sessions.settings.boot.stored': '正式（存着的设备）',
  'sessions.settings.boot.mock': '模拟核心',
  'sessions.settings.boot.fixture': '测试夹具',
  'sessions.settings.mode': '现在：{mode}',
} satisfies Record<`sessions.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'sessions.new': 'New session',
  'sessions.newHere': 'New session here',
  'sessions.more': 'More',
  'sessions.files': 'Browse files',
  'sessions.empty': 'No sessions on this device yet',
  'sessions.empty.note': 'Tap “＋” at the top right to start one.',
  'sessions.banner': '{state}: {note}',
  'sessions.failed.dismiss': 'Tap to dismiss',
  'sessions.move.none': 'No other project to move to',
  'sessions.files.title': 'Files',
  'sessions.files.up': 'Up one level',
  'sessions.files.line': 'Line {n}',
  'sessions.files.notFound': 'No such line (the file has {n} lines)',
  'sessions.settings.lang.system': 'Follow the system',
  'sessions.settings.lang.note':
    'When following the system, Chinese or English is picked from the phone’s language.',
  'sessions.settings.theme.note':
    'When following the system, this switches along with the system’s light or dark mode.',
  'sessions.settings.dev': 'Developer',
  'sessions.settings.boot': 'Startup',
  'sessions.settings.boot.note':
    'Changing it restarts the core; devices that are connected will disconnect.',
  'sessions.settings.boot.stored': 'Normal (saved devices)',
  'sessions.settings.boot.mock': 'Mock core',
  'sessions.settings.boot.fixture': 'Test fixture',
  'sessions.settings.mode': 'Now: {mode}',
}
