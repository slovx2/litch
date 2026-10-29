import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'connection.settings': '连接',
  'connection.timeout': '后台断开连接',
  'connection.minutes': '{n} 分钟后',
  'connection.never': '从不',
  'connection.timeout.note':
    '在后台超过所选时长后断开，返回应用时自动恢复。系统暂停应用时，断开可能延迟。',
  'connection.never.note': 'Litch 不主动断开后台连接，系统仍可能限制后台运行。',
  'connection.system': '系统后台设置',
  'connection.system.note': '如需保持后台连接，请允许 Litch 后台运行，或将电池优化设为不限制。',
  'connection.battery.exempt': '标准电池优化：已豁免',
  'connection.battery.restricted': '标准电池优化：未豁免',
  'connection.battery.unknown': '标准电池优化：无法读取',
  'connection.battery.note': '部分手机还需开启“允许后台行为”。',
  'connection.open': '打开系统设置',
  'connection.guide': '在系统设置中选择应用 → Litch → 电池/后台管理，允许后台运行或选择不限制。',
  'connection.open.failed': '无法打开系统设置，请按以下路径手动设置。',
} satisfies Record<`connection.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'connection.settings': 'Connection',
  'connection.timeout': 'Disconnect in background',
  'connection.minutes': 'After {n} min',
  'connection.never': 'Never',
  'connection.timeout.note':
    'Disconnect after this time in the background and reconnect when you return. Disconnection may be delayed while the system suspends the app.',
  'connection.never.note':
    'Litch will not disconnect automatically. The system may still restrict background activity.',
  'connection.system': 'System background settings',
  'connection.system.note':
    'To stay connected in the background, allow background activity for Litch or set battery usage to unrestricted.',
  'connection.battery.exempt': 'Standard battery optimization: exempt',
  'connection.battery.restricted': 'Standard battery optimization: not exempt',
  'connection.battery.unknown': 'Standard battery optimization: unavailable',
  'connection.battery.note': 'Some phones also require “Allow background activity”.',
  'connection.open': 'Open system settings',
  'connection.guide':
    'In system settings, go to Apps → Litch → Battery or background management, then allow background activity or choose unrestricted.',
  'connection.open.failed':
    'Could not open system settings. Follow the path below to change it manually.',
}
