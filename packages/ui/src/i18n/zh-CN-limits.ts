// 账号额度的中文文案：用量环弹层里上下文下面那几行。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-limits.ts。
import type { Entry } from './types.ts'

export const zhLimits = {
  'limits.window.hours': '{n} 小时额度',
  'limits.window.days': '{n} 天额度',
  'limits.window.week': '每周额度',
  'limits.window.other': '额度',
  'limits.named': '{name} · {window}',
  'limits.used': '已用 {percent}%',
  'limits.resetsIn': '{when}后重置',
  'limits.resetSoon': '即将重置',
  'limits.in.minutes': '{m} 分钟',
  'limits.in.hours': '{h} 小时 {m} 分',
  'limits.in.days': '{d} 天 {h} 小时',
} satisfies Record<string, Entry>
