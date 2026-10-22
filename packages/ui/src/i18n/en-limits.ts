// English copy for plan usage limits in the context meter popover. Keys mirror zh-CN-limits.ts.
import type { Entry } from './types.ts'

export const enLimits = {
  'limits.window.hours': '{n}-hour limit',
  'limits.window.days': '{n}-day limit',
  'limits.window.week': 'Weekly limit',
  'limits.window.other': 'Limit',
  'limits.named': '{name} · {window}',
  'limits.used': '{percent}% used',
  'limits.resetsIn': 'Resets in {when}',
  'limits.resetSoon': 'Resets soon',
  'limits.in.minutes': '{m}m',
  'limits.in.hours': '{h}h {m}m',
  'limits.in.days': '{d}d {h}h',
} satisfies Record<string, Entry>
