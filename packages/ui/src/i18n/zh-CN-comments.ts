// 选中回答文字加评论的中文文案：选区上的浮层、编辑框、输入框上的片、原文上的记号、对话里的评论卡片、回答里的 [N]。
// 并进 zh-CN.ts 的那一份里用（键的集合以那一份为准），英文在 en-comments.ts。
import type { Entry } from './types.ts'

export const zhComments = {
  'comment.pop': '对选中的文字',
  'comment.add': '评论',
  'comment.edit': '改评论',
  'comment.full': '一条消息最多带 {max} 条评论',
  'comment.placeholder': '写点评论（可以不写）',
  'comment.quote.more': '展开引用',
  'comment.quote.less': '收起引用',
  'comment.keys': '↵ 加入 · {send} 直接发送',
  'comment.send': '直接发送',
  'comment.send.note': '只把这一条发出去，输入框里别的不动',
  'comment.save.new': '加入',
  'comment.save': '保存',
  'comment.locate': '定位原文',
  'comment.delete': '删除',
  'comment.remove': '删掉评论 {n}',
  'comment.badge': '评论 {n}：点开修改',
  'comment.sent': '{n} 条评论',
  'comment.card.label': '评论 {n}',
  'comment.card.open': '跳到原文',
  'comment.cite': '评论 {n}',
  'comment.cite.label': '回应评论 {n}，点了跳到原文',
} satisfies Record<string, Entry>
