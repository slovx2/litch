// 手机端自己的文案：对话区线：对话区的各种条目。键加前缀 "detail."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'detail.placeholder': '（detail）',
} satisfies Record<`detail.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'detail.placeholder': '(detail)',
}
