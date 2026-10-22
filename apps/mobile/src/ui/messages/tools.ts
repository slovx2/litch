// 手机端自己的文案：工具页线：终端、差异。键加前缀 "tools."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
// 终端用了桌面的 terminal.*（新开、改名、清屏、关闭、各种状态、重开、略过了一段），差异用了 diffs.*（范围、状态、各种说明）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'tools.term.list': '终端（{n}）',
  'tools.term.more': '更多',
  'tools.term.pick': '这台设备上的终端',
  'tools.term.item': '{name} · {state}',
  'tools.term.itemHere': '▸ {name} · {state}',
  'tools.term.attach': '重新连接：{name}',
  'tools.term.opening': '正在打开终端…',
  'tools.term.retry': '重试',
  'tools.term.showKeyboard': '弹出键盘',
  'tools.term.hideKeyboard': '收起键盘',
  'tools.term.state.starting': '正在启动',
  'tools.term.state.running': '运行中',
  'tools.term.state.exited': '已退出',
  'tools.term.state.lost': '已结束',
  'tools.term.state.away': '等待设备连接',
  'tools.diff.title': '改动',
  'tools.diff.files': '{files} 个文件  +{added} −{removed}',
  'tools.diff.back': '返回文件列表',
  'tools.diff.lineCount': '+{added} −{removed}',
  'tools.diff.lines': '{n} 行',
} satisfies Record<`tools.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'tools.term.list': 'Terminals ({n})',
  'tools.term.more': 'More',
  'tools.term.pick': 'Terminals on this device',
  'tools.term.item': '{name} · {state}',
  'tools.term.itemHere': '▸ {name} · {state}',
  'tools.term.attach': 'Reattach: {name}',
  'tools.term.opening': 'Opening a terminal…',
  'tools.term.retry': 'Try again',
  'tools.term.showKeyboard': 'Show keyboard',
  'tools.term.hideKeyboard': 'Hide keyboard',
  'tools.term.state.starting': 'Starting',
  'tools.term.state.running': 'Running',
  'tools.term.state.exited': 'Exited',
  'tools.term.state.lost': 'Ended',
  'tools.term.state.away': 'Waiting for device',
  'tools.diff.title': 'Changes',
  'tools.diff.files': '{files} files  +{added} −{removed}',
  'tools.diff.back': 'Back to the file list',
  'tools.diff.lineCount': '+{added} −{removed}',
  'tools.diff.lines': '{n} lines',
}
