// 重启设备服务（侧栏设备行“⋯”里的那一项、确认框、结果提示、对话末尾那一句）的中文文案。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-restart.ts。
import type { Entry } from './types.ts'

export const zhRestart = {
  'restart.settings': '设置',
  'restart.menu': '强制重启',
  'restart.menu.busy': '正在重启…',
  'restart.blocked.offline': '设备未连接',
  'restart.blocked.single': '只连接了单个 harness，没有设备服务',
  'restart.blocked.managed': '服务由前台或服务管理器启动，请用原来的方式重启',
  'restart.blocked.upgrading': '正在升级设备服务',
  'restart.pill': '重启中',
  'restart.confirm.title': '重启 {name} 的设备服务？',
  'restart.confirm.note':
    '以下工作会被打断。符合条件的普通回合将在重启后自动继续；已停止、待答和自动任务不会恢复：',
  'restart.confirm.turn': '回合进行中',
  'restart.confirm.background': '{count} 个后台任务',
  'restart.confirm.more': '另有 {count} 个会话',
  'restart.confirm.yes': '重启',
  'restart.confirm.no': '取消',
  'restart.busy.title': '{name} 的设备服务正忙',
  'restart.busy.note': '立即重启会中断以下工作：',
  'restart.busy.yes': '仍然重启',
  'restart.done': '已重启 {name} 的设备服务',
  'restart.done.interrupted': '已重启 {name} 的设备服务，{count} 个会话被打断',
  'restart.failed': '{name} 的设备服务未能重启：{reason}',
  'restart.failed.because': '{reason}（{said}）',
  'restart.failed.connect': '无法连接该设备',
  'restart.failed.unsupported': '正在运行的服务不支持停止请求，需要手动结束一次',
  'restart.failed.legacy': '正在运行的是不带聚合面的旧服务，需要手动重启',
  'restart.failed.stop': '设备服务未能停止',
  'restart.failed.start': '设备服务已停止，但未能重新连接',
  'restart.failed.stale': '重新连接后运行的仍是原来的服务',
  'restart.again': '重试',
  'restart.note': '设备服务已重启。符合条件的回合将自动继续；未恢复的回合可手动继续。',
} satisfies Record<string, Entry>
