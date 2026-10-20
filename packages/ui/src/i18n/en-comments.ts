// 选中回答文字加评论的英文文案。键必须和 zh-CN-comments.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhComments } from './zh-CN-comments.ts'

export const enComments: Record<keyof typeof zhComments, Entry> = {
  'comment.pop': 'Selected text',
  'comment.add': 'Comment',
  'comment.edit': 'Edit comment',
  'comment.full': 'A message can carry at most {max} comments',
  'comment.placeholder': 'Add a comment (optional)',
  'comment.quote.more': 'Show full quote',
  'comment.quote.less': 'Fold quote',
  'comment.keys': '↵ add · {send} send now',
  'comment.send': 'Send now',
  'comment.send.note': 'Send only this one; leave the rest of the composer as is',
  'comment.save.new': 'Add',
  'comment.save': 'Save',
  'comment.locate': 'Show in reply',
  'comment.delete': 'Delete',
  'comment.remove': 'Remove comment {n}',
  'comment.badge': 'Comment {n}: click to edit',
  'comment.sent': ({ n }) => `${n} ${Number(n) === 1 ? 'comment' : 'comments'}`,
  'comment.card.label': 'Comment {n}',
  'comment.card.open': 'Jump to the quoted text',
  'comment.cite': 'Comment {n}',
  'comment.cite.label': 'Answers comment {n}; click to jump to the quoted text',
}
