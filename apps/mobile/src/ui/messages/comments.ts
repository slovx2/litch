// 手机端自己的文案：评论线：选中回答里的一段加评论、输入框上的评论片、对话里的评论卡片和 [N] 记号。
// 键加前缀 "comment."，中英文各一份，键必须一致（en 的类型约束保证）。
import type { Entry } from '../../../../../packages/ui/src/i18n/types.ts'

export const zhCN = {
  'comment.menu': '评论这条回答',
  'comment.pick.title': '选一段加评论',
  'comment.pick.hint': '长按选中一段，再点下面的“评论”',
  'comment.pick.selected': '已选 {n} 个字',
  'comment.pick.none': '还没选',
  'comment.pick.gone': '这条回答已经不在了',
  'comment.full': '一条消息最多带 {max} 条评论，先删掉几条再加',
  'comment.add': '评论',
  'comment.editor.new': '加评论',
  'comment.editor.placeholder': '写点评论（可以不写）',
  'comment.editor.add': '加上',
  'comment.editor.save': '保存',
  'comment.editor.remove': '删掉',
  'comment.locate': '定位原文',
  'comment.notFound': '原文不在这个会话里了',
  'comment.close': '关上',
  'comment.noNote': '（没写评论）',
  /** 评论片、卡片的编号，回答里 [N] 画成的记号 */
  'comment.ref': '评论 {n}',
  'comment.chip.remove': '删掉评论 {n}',
  'comment.count': '{n} 条评论',
} satisfies Record<`comment.${string}`, Entry>

export const en: Record<keyof typeof zhCN, Entry> = {
  'comment.menu': 'Comment on this reply',
  'comment.pick.title': 'Comment on a passage',
  'comment.pick.hint': 'Long-press to select a passage, then tap Comment below',
  'comment.pick.selected': ({ n }) =>
    n === 1 ? '1 character selected' : `${n} characters selected`,
  'comment.pick.none': 'Nothing selected',
  'comment.pick.gone': 'This reply is no longer available',
  'comment.full': 'A message can carry up to {max} comments. Remove some first',
  'comment.add': 'Comment',
  'comment.editor.new': 'Add comment',
  'comment.editor.placeholder': 'Add a comment (optional)',
  'comment.editor.add': 'Add',
  'comment.editor.save': 'Save',
  'comment.editor.remove': 'Remove',
  'comment.locate': 'Show original',
  'comment.notFound': 'The original text is no longer in this session',
  'comment.close': 'Close',
  'comment.noNote': '(no comment)',
  'comment.ref': 'Comment {n}',
  'comment.chip.remove': 'Remove comment {n}',
  'comment.count': ({ n }) => (n === 1 ? '1 comment' : `${n} comments`),
}
