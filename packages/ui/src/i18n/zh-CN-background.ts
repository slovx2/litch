// 后台任务的中文文案：输入框上方那一行、侧面板的“后台任务”页、收起行和侧栏上的记号、自发回合开头那一行。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-background.ts。
import type { Entry } from './types.ts'

export const zhBackground = {
  'side.tab.background': '后台任务',
  'background.bar': '{count} 个后台任务正在运行',
  'background.barOpen': '在右侧查看后台任务',
  'background.barClose': '收起后台任务',
  'background.inTurn': '{count} 个在后台运行',
  'background.sidebar': '{count} 个后台任务正在运行',
  'sidebar.tally.background': '{count} 个后台任务正在运行',
  'background.running': '运行中',
  'background.ended': '已结束',
  'background.none': '没有正在运行的后台任务',
  'background.noneEver':
    '此会话暂无后台任务。回合结束后仍在运行的命令、子代理和子会话会显示在这里。',
  'background.pick': '打开会话后，此处显示其后台任务。',
  'background.wakes': '完成后自动继续',
  'background.noWake': '完成后不会自动继续',
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
  'background.origin.queue': '排队的消息，已自动发送',
  'background.origin.peer': '另一个会话发来消息',
  // 后台任务和子代理合成一页（子代理、子会话也算后台任务），能停的给“停止”，命令看输出
  'background.stop': '停止',
  'background.stop.title': '停止此后台任务',
  'background.stopping': '正在停止',
  'background.output.none': '暂无输出',
  'background.output.unknown': '找不到此命令的输出',
  'fault.backgroundStop': '无法停止此后台任务：它可能已结束，或当前 harness 不支持单独停止',
} satisfies Record<string, Entry>
