// 强度档怎么叫。键是对面报的标识：上游 codex 的几档（none 到 persistent）和 Pi 的 off。
// 不认识的照对面给的标识显示。哪些档会报上来、各叫什么，packages/ui/test/efforts.test.mjs 守着
import type { MessageKey } from '../i18n/index.ts'

export const EFFORT_TEXT: Record<string, MessageKey> = {
  none: 'effort.none',
  // Pi 的“不思考”
  off: 'effort.none',
  minimal: 'effort.minimal',
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
  // 比 max 还高一档：上游说它会动用多个代理，用量最大
  ultra: 'effort.ultra',
  persistent: 'effort.persistent',
}
