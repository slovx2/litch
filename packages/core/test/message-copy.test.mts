import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askReplyText } from '../src/projection/asks.mjs'
import { commentsBlock } from '../src/projection/comments.mjs'
import { type CopyMessage, messageCopyText } from '../src/projection/message-copy.mjs'
import { localUserMessage, outgoing } from '../src/projection/outgoing.mjs'

const copy = (item: CopyMessage) => messageCopyText(item, (attachment) => attachment.kind)
const user = (text: string): CopyMessage => ({ kind: 'userMessage', text, attachments: [] })

test('用户与回答完整保留 Markdown 和空白，不按渲染块截断', () => {
  const text = ['  # 标题\n\n**强调**\n\n```ts\nconst x = 1\n```\n', '末尾\n'.repeat(2000)].join('')
  assert.equal(copy(user(text)), text)
  assert.equal(copy({ kind: 'agentMessage', text }), text)
  assert.equal(copy({ kind: 'agentMessage', text: '过程说明' }), '过程说明')
})

test('评论复制编号、引用、备注和正文，剥掉内部要求，保留坏格式原文', () => {
  const block = commentsBlock([
    { kind: 'comment', itemId: 'a', quote: '**原文**\n下一行', note: '修正' },
    { kind: 'comment', itemId: 'b', quote: '第二段', note: '' },
  ])
  assert.equal(
    copy(user(`${block}\n\n后续正文`)),
    '[1] **原文**\n下一行\n修正\n\n[2] 第二段\n\n后续正文',
  )
  const malformed = '<litch-comments>用户自己写的标签'
  assert.equal(copy(user(malformed)), malformed)
})

test('真实发出再投影的会话提及只复制显示标题，附件不泄漏 data URL 或技能路径', () => {
  const item = localUserMessage(
    'u',
    outgoing(
      '看看 @[相关会话]',
      [
        { url: 'data:image/png;base64,private', name: '截图.png' },
        { url: 'data:image/png;base64,private2', name: null },
      ],
      [
        { kind: 'session', threadId: 'secret-id', title: '相关会话' },
        { kind: 'skill', name: '检查', path: '/private/skill' },
      ],
    ),
    true,
  )
  assert.equal(copy(item), '检查\n\n截图.png\n\nimage\n\n看看 相关会话')
})

test('答题消息只复制题目和答案，不复制 JSON 标识；系统和协作消息保持展开的原文', () => {
  const reply = { questionItemId: 'hidden-id', question: '颜色？', answer: '蓝色' }
  assert.equal(copy(user(askReplyText([reply, reply]))), '颜色？\n蓝色')
  const text = commentsBlock([{ kind: 'comment', itemId: 'a', quote: '引用', note: '' }])
  assert.equal(
    copy({
      ...user(text),
      kind: 'userMessage',
      attachments: [],
      peer: { name: null, session: null, bypass: false },
    }),
    text,
  )
})

test('纯图片消息复制可读名称，空消息为空', () => {
  assert.equal(
    copy({
      kind: 'userMessage',
      text: '',
      attachments: [{ kind: 'image', label: null, url: 'data:secret' }],
    }),
    'image',
  )
  assert.equal(copy(user('')), '')
})
