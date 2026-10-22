// English copy for plan usage limits in the context meter popover. Keys mirror zh-CN-limits.ts.
import type { Entry } from './types.ts'

export const enLimits = {
  'limits.title': 'Plan usage',
  'limits.window.hours': '{n}-hour',
  'limits.window.days': '{n}-day',
  'limits.window.week': 'Weekly',
  'limits.window.other': 'Limit',
  'limits.named': '{name} · {window}',
  'limits.used': '{percent}% used',
  'limits.resetsIn': 'Resets in {when}',
  'limits.resetSoon': 'Resets soon',
  'limits.in.minutes': '{m}m',
  'limits.in.hours': '{h}h {m}m',
  'limits.in.days': '{d}d {h}h',
} satisfies Record<string, Entry>
