// 设置页“按 harness 开关”那棵树的英文文案。键必须和 zh-CN-switches.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhSwitches } from './zh-CN-switches.ts'

export const enSwitches: Record<keyof typeof zhSwitches, Entry> = {
  'switches.col.name': 'Device and harness',
  'switches.col.taskCards': 'Task cards',
  'switches.col.browser': 'Built-in browser',
  'switches.col.computer': 'Computer Use',
  'switches.note':
    'Clicking a device cell sets all its harnesses. Harnesses installed later follow the same setting.',
  'switches.note.taskCards':
    'Task cards: suggested-task cards and turn wrap-ups in sessions. Turning them off doesn’t affect sub-sessions or other features. Stored on the device, so it also applies to sessions started from a phone and to scheduled tasks. Can’t be changed while the device is offline.',
  'switches.note.tools':
    'Built-in browser and Computer Use: stored on this computer. When off, new sessions don’t get these tools and existing sessions are refused on their next call. Turning them back on applies to new sessions only. On first capture, macOS may also ask for direct screen access; click Allow.',
  'switches.offline': 'Offline',
  'switches.expand': 'Expand {name}',
  'switches.collapse': 'Collapse {name}',
  'switches.cell': '{name}: {column}',
  'switches.cell.device': 'All harnesses on {name}: {column}',
  'switches.unknown.offline':
    'Device offline. Task card settings are stored on the device and can be viewed and changed once it connects',
  'switches.unknown.old':
    'This device’s service doesn’t support the task card switch. Update it to use this',
  'switches.unknown.loading': 'Reading the settings on the device…',
  'switches.failed': 'Couldn’t change: {reason}',
  'switches.empty': 'No devices.',
  'switches.summary.all': 'On for all',
  'switches.summary.none': 'Off for all',
  'switches.summary.some': 'On for {names} only',
  'switches.summary.unknown': 'Shown once the device connects',
  'switches.go': 'Change in Settings',
  'switches.detail.note':
    'Task cards for sessions on this device, and this computer’s built-in browser and Computer Use, are switched per harness.',
}
