// 设置页“按 harness 开关”那棵树的英文文案。键必须和 zh-CN-switches.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhSwitches } from './zh-CN-switches.ts'

export const enSwitches: Record<keyof typeof zhSwitches, Entry> = {
  'switches.col.name': 'Device and harness',
  'switches.col.taskCards': 'Task cards',
  'switches.col.browser': 'Built-in browser',
  'switches.col.computer': 'Computer Use',
  'switches.note':
    'Switch each harness on each device separately. A device cell is worked out from its harnesses: checked when all are on, empty when all are off, half-checked otherwise; clicking it sets the whole column for that device. Harnesses installed later follow the device cell.',
  'switches.note.taskCards':
    'Task cards: sessions suggest follow-up tasks as cards and wrap up each turn. Turning them off removes only that; starting sub-sessions and the rest still work. Stored on the device, so sessions started from a phone and scheduled tasks follow it too; it cannot be changed while the device is offline.',
  'switches.note.tools':
    'Built-in browser and Computer Use: stored on this computer. While off, new sessions do not get these tools and existing sessions are refused on their next call; after turning them on, new sessions get them.',
  'switches.offline': 'offline',
  'switches.expand': 'Expand {name}',
  'switches.collapse': 'Collapse {name}',
  'switches.cell': '{name}: {column}',
  'switches.cell.device': 'All harnesses on {name}: {column}',
  'switches.unknown.offline':
    'The device is offline: task cards are stored on the device and can be seen and changed once it connects',
  'switches.unknown.old':
    'The device service on this device has no task-card switch yet; update it to get one',
  'switches.unknown.loading': 'Reading the settings on the device…',
  'switches.failed': 'Not changed: {reason}',
  'switches.empty': 'No devices yet.',
  'switches.summary.all': 'on for all',
  'switches.summary.none': 'off for all',
  'switches.summary.some': 'on for {names} only',
  'switches.summary.unknown': 'shown once the device connects',
  'switches.go': 'Change in Settings',
  'switches.detail.note':
    'Whether sessions on this device can use task cards, and this computer’s built-in browser and Computer Use, switched per harness.',
}
