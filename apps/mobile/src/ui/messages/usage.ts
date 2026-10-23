// 手机端自己的文案：用量页（上下文、账号额度、压缩）和会话菜单里的这两项。键加前缀 "usage."，中英文各一份。
// 额度、上下文的说法用桌面的 limits.*、context.*，这里只有手机上另需的几句。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'usage.title': '用量',
  'usage.menu': '用量与额度',
  'usage.limits': '账号额度',
  'usage.reading': '正在读取账号额度…',
  'usage.noLimits': '没有额度信息（订阅登录的账号才有）',
} satisfies Record<`usage.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'usage.title': 'Usage',
  'usage.menu': 'Usage and limits',
  'usage.limits': 'Account limits',
  'usage.reading': 'Reading account limits…',
  'usage.noLimits': 'No limits reported (only subscription logins have them)',
}
