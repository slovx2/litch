// 手机端自己的文案：建议任务（对话里的提案卡、建议任务列表、改了再开始）和没收尾时的提醒。键加前缀 "proposals."。
// 卡片上的按钮、状态、简报展开收起、沙箱提醒，表单里的各项名字，用桌面已有的 proposal.*、tree.*（src/ui/i18n.ts）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'proposals.title': '建议任务',
  'proposals.menu': '建议任务',
  'proposals.strip': '{n} 个建议任务等你开始',
  'proposals.none': '这个对话里还没有建议任务',
  'proposals.nonePending': '没有等着开始的建议任务',
  'proposals.pending': '等着开始（{n}）',
  'proposals.settled': '已了结（{n}）',
  'proposals.notInChat': '对话里找不到这张卡片了',
  'proposals.remind': '模型没收尾，Litch 提醒了它一次',
  'proposals.start.from': '提出它的会话',
  'proposals.start.settled': '这张提案{state}，不能再开始了',
  'proposals.start.gone': '找不到这张提案了',
} satisfies Record<`proposals.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'proposals.title': 'Suggested tasks',
  'proposals.menu': 'Suggested tasks',
  'proposals.strip': ({ n }) =>
    n === 1 ? '1 suggested task waiting for you' : `${n} suggested tasks waiting for you`,
  'proposals.none': 'No suggested tasks in this chat yet',
  'proposals.nonePending': 'Nothing waiting to start',
  'proposals.pending': 'Waiting ({n})',
  'proposals.settled': 'Settled ({n})',
  'proposals.notInChat': "This card isn't in the chat anymore",
  'proposals.remind': 'The model skipped wrap-up; Litch reminded it once',
  'proposals.start.from': 'Proposed in',
  'proposals.start.settled': 'This proposal can no longer start ({state})',
  'proposals.start.gone': 'This proposal is gone',
}
