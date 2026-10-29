// 设置页“按 harness 开关”那棵树、设备详情里那一行摘要的中文文案。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-switches.ts。
import type { Entry } from './types.ts'

export const zhSwitches = {
  'switches.col.name': '设备与 harness',
  'switches.col.taskCards': '任务卡',
  'switches.col.browser': '内置浏览器',
  'switches.col.computer': 'Computer Use',
  'switches.note': '点击设备一格会统一设置其下所有 harness；之后新安装的 harness 也沿用该设置。',
  'switches.note.taskCards':
    '任务卡：会话中的建议任务卡片和回合收尾。关闭不影响子会话等其他功能。设置保存在设备上，对手机发起的会话和定时任务同样生效；设备离线时无法修改。',
  'switches.note.tools':
    '内置浏览器、Computer Use：设置保存在本机。关闭后新会话不带这组工具，已有会话的下一次调用会被拒绝；重新开启后仅对新会话生效。macOS 首次采集画面可能另弹出“直接访问屏幕”确认，请点“允许”。',
  'switches.offline': '离线',
  'switches.expand': '展开 {name}',
  'switches.collapse': '收起 {name}',
  'switches.cell': '{name}：{column}',
  'switches.cell.device': '{name} 的所有 harness：{column}',
  'switches.unknown.offline': '设备未连接：任务卡设置保存在设备上，连接后才能查看和修改',
  'switches.unknown.old': '此设备的设备服务不支持任务卡开关，请升级',
  'switches.unknown.loading': '正在读取设备上的设置…',
  'switches.failed': '修改失败：{reason}',
  'switches.empty': '暂无设备。',
  'switches.summary.all': '全部开启',
  'switches.summary.none': '全部关闭',
  'switches.summary.some': '仅对 {names} 开启',
  'switches.summary.unknown': '设备连接后可见',
  'switches.go': '前往设置修改',
  'switches.detail.note':
    '按 harness 分别控制此设备会话的任务卡，以及本机的内置浏览器和 Computer Use。',
} satisfies Record<string, Entry>
