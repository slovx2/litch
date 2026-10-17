// 手机端自己的文案：输入线：输入区、审批与提问、新会话。键加前缀 "compose."，中英文各一份，键必须一致（en 的类型约束保证）。
// 桌面界面已有的句子（包括核心要说的话）直接用，不在这里重抄：见 src/ui/i18n.ts。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'compose.placeholder': '（compose）',
} satisfies Record<`compose.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'compose.placeholder': '(compose)',
}
