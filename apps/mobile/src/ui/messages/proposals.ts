// 手机端自己的文案：建议任务（对话里的提案卡、offer 卡、交接卡、建议任务列表、改了再开始）和没收尾时的提醒。键加前缀 "proposals."。
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
  'proposals.state.offered': '等你选',
  'proposals.state.chosen': '等模型补简报',
  'proposals.state.here': '在这里做',
  'proposals.offer.kind': '新任务',
  'proposals.offer.ask': '这和当前对话无关，开一个新会话来做，还是就在这里做？',
  'proposals.offer.chosen': '模型在写简报，写好就开新会话',
  'proposals.offer.here.note': '就在这个会话里接着做',
  'proposals.offer.session': '新会话',
  'proposals.offer.here': '在这里做',
  'proposals.handoff.kind': '交给了分叉会话',
  'proposals.handoff.running': '正在交给分叉会话',
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
  'proposals.state.offered': 'Your call',
  'proposals.state.chosen': 'Waiting for the brief',
  'proposals.state.here': 'Doing it here',
  'proposals.offer.kind': 'New task',
  'proposals.offer.ask':
    "This isn't related to this chat. Start a new session for it, or do it here?",
  'proposals.offer.chosen':
    'The model is writing the brief; the new session starts when it is done',
  'proposals.offer.here.note': 'Continuing in this session',
  'proposals.offer.session': 'New session',
  'proposals.offer.here': 'Do it here',
  'proposals.handoff.kind': 'Handed off to a forked session',
  'proposals.handoff.running': 'Handing off to a forked session',
}
