// 设置页“按 harness 开关”那棵树、设备详情里那一行摘要的中文文案。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-switches.ts。
import type { Entry } from './types.ts'

export const zhSwitches = {
  'switches.col.name': '设备与 harness',
  'switches.col.taskCards': '任务卡',
  'switches.col.browser': '内置浏览器',
  'switches.col.computer': 'Computer Use',
  'switches.note':
    '每台设备下面的各 harness 分别开关。设备那一格是算出来的：全开打勾、全关空着、有开有关是半选，点它把这台设备的整列一起设。以后新装的 harness 跟着设备那一格。',
  'switches.note.taskCards':
    '任务卡：会话里出建议任务卡片、回合末尾收尾。关掉只去掉这部分，派子会话等照旧。存在设备上，手机发起的会话、定时任务也照这里，设备离线时改不了。',
  'switches.note.tools':
    '内置浏览器、Computer Use：存在这台电脑上。关着时新建的会话不带这组工具，已经建好的会话下一次调用就被挡住；打开之后，新建的会话才有。',
  'switches.offline': '离线',
  'switches.expand': '展开 {name}',
  'switches.collapse': '收起 {name}',
  'switches.cell': '{name}：{column}',
  'switches.cell.device': '{name} 的全部 harness：{column}',
  'switches.unknown.offline': '设备没连着：任务卡存在设备上，连上之后才看得到、改得了',
  'switches.unknown.old': '这台设备的设备服务还没有任务卡开关，升级之后才有',
  'switches.unknown.loading': '正在读设备上的设置…',
  'switches.failed': '没改成：{reason}',
  'switches.empty': '还没有设备。',
  'switches.summary.all': '全部开着',
  'switches.summary.none': '全部关着',
  'switches.summary.some': '只对 {names} 开着',
  'switches.summary.unknown': '设备连上之后才看得到',
  'switches.go': '去设置里改',
  'switches.detail.note':
    '这台设备上的会话能不能用任务卡，和这台电脑上的内置浏览器、Computer Use，按 harness 分别开关。',
} satisfies Record<string, Entry>
