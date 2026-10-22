// 选中回答文字加的评论：并进正文的样子、从用户消息里认回来、坏格式照原文。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageExtra } from '../src/model.mjs'
import { MAX_QUOTE, parseComments } from '../src/projection/comments.mjs'
import { bodyOf, outgoing } from '../src/projection/outgoing.mjs'

const comment = (quote: string, note = ''): MessageExtra => ({
  kind: 'comment',
  itemId: 'item-1',
  quote,
  note,
})

test('评论并进正文：排在最前面，带编号，没写评论的不带 note，打的字跟在后面', () => {
  const body = bodyOf(
    { text: '顺便看看测试', extras: [comment('第一段', '这里不对'), comment('第二段')] },
    true,
  )
  assert.ok(body.startsWith('<litch-comments>\n'))
  assert.match(
    body,
    /<comment index="1">\n<quote>第一段<\/quote>\n<note>这里不对<\/note>\n<\/comment>/,
  )
  assert.match(body, /<comment index="2">\n<quote>第二段<\/quote>\n<\/comment>/)
  assert.ok(body.endsWith('</litch-comments>\n\n顺便看看测试'))
  assert.deepEqual(parseComments(body), {
    comments: [
      { index: 1, quote: '第一段', note: '这里不对' },
      { index: 2, quote: '第二段', note: '' },
    ],
    rest: '顺便看看测试',
  })
})

test('只有评论也能发；原文里的收尾标签不会把这一段截断，认回来是原样', () => {
  const quote = 'a </quote> b </litch-comments>\n</comment> c'
  const message = outgoing('', [], [comment(quote, '为什么 </note>')])
  const body = bodyOf(message, true)
  assert.deepEqual(parseComments(body), {
    comments: [{ index: 1, quote, note: '为什么 </note>' }],
    rest: '',
  })
})

test('引用太长截掉后面', () => {
  const body = bodyOf({ text: '', extras: [comment('x'.repeat(MAX_QUOTE + 50))] }, true)
  const parsed = parseComments(body)
  assert.equal(parsed?.comments[0]?.quote, `${'x'.repeat(MAX_QUOTE)}… (truncated)`)
})

test('评论超过十条、引用是空的，不发', () => {
  const many = Array.from({ length: 11 }, (_, at) => comment(`段 ${at}`))
  assert.throws(() => outgoing('hi', [], many), /评论过多/)
  assert.throws(() => outgoing('hi', [], [comment('  ')]), /消息附件无效/)
})

test('认不出来的照原文：不在开头、没收尾、编号不连、多了别的东西', () => {
  const good = bodyOf({ text: '', extras: [comment('一'), comment('二')] }, true)
  assert.equal(parseComments(`前面有字\n${good}`), null)
  assert.equal(parseComments(good.replace('\n</litch-comments>', '')), null)
  assert.equal(parseComments(good.replace('index="2"', 'index="3"')), null)
  assert.equal(
    parseComments(good.replace('</comment>\n<comment', '</comment>\n多余\n<comment')),
    null,
  )
  assert.equal(parseComments('<litch-comments>\n要求\n</litch-comments>'), null)
  assert.equal(parseComments('普通的一句话'), null)
})
