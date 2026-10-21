// 后台任务的中文文案：输入框上方那一行、侧面板的“后台任务”页、收起行和侧栏上的记号、自发回合开头那一行。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-background.ts。
import type { Entry } from './types.ts'

export const zhBackground = {
  'side.tab.background': '后台任务',
  'background.bar': '{count} 个后台任务在跑',
  'background.barOpen': '在右侧查看后台任务',
  'background.barClose': '收起后台任务',
  'background.inTurn': '{count} 个在后台运行',
  'background.sidebar': '{count} 个后台任务在跑',
  'sidebar.tally.background': '{count} 个后台任务在跑',
  'background.running': '运行中',
  'background.ended': '已结束',
  'background.none': '没有在跑的后台任务',
  'background.noneEver': '这个会话还没有后台任务。回合说完以后还在跑的命令会出现在这里。',
  'background.pick': '打开一个会话，这里列它的后台任务。',
  'background.wakes': '跑完会自动接着做',
  'background.noWake': '跑完不会自动接着做',
  'background.status.running': '进行中',
  'background.status.completed': '完成',
  'background.status.failed': '失败',
  'background.status.stopped': '已停止',
  'background.kind.shell': '命令',
  'background.kind.agent': '子代理',
  'background.kind.monitor': '监视',
  'background.kind.workflow': '工作流',
  'background.kind.remote': '远程任务',
  'background.kind.other': '任务',
  'background.origin.backgroundTask': '后台任务结束，自动继续',
  'background.origin.schedule': '定时任务触发',
  'background.origin.goal': '目标未达成，自动继续',
  'background.origin.queue': '排着的消息，自动发出',
} satisfies Record<string, Entry>
