// 模型边干活边问的题：答复的写法、认回来、答复表、卡片的三种样子，以及分块时它露在过程外面、不算最终回答。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ItemView } from '../src/model.mjs'
import {
  askQuestionId,
  askReplyText,
  askState,
  gatherAnswers,
  parseAskReply,
  projectQuestions,
} from '../src/projection/asks.mjs'
import { answerOf, bucketItems, cardPlace } from '../src/projection/blocks.mjs'

const user = (id: string, text: string): ItemView => ({
  id,
  kind: 'userMessage',
  text,
  attachments: [],
})

test('题目标识和官方客户端一样是 JSON 数组；空题目、空选项不要', () => {
  assert.equal(askQuestionId('call_1', 0), '["request_user_input_async","call_1",0]')
  assert.deepEqual(
    projectQuestions('call_1', [
      { title: '要不要跳过？', options: ['跳过', ' ', '照跑'] },
      { title: '  ', options: null },
      { title: '发到哪？', options: [] },
    ]),
    [
      { id: askQuestionId('call_1', 0), title: '要不要跳过？', options: ['跳过', '照跑'] },
      { id: askQuestionId('call_1', 2), title: '发到哪？', options: [] },
    ],
  )
  assert.equal(projectQuestions('call_1', null), undefined)
  assert.equal(projectQuestions('call_1', [{ title: '', options: null }]), undefined)
})

test('答复写成一段标签包着的 JSON，字段先后和官方桌面端一样；认得回来', () => {
  const replies = [
    { questionItemId: askQuestionId('c', 0), question: '要不要跳过？', answer: '跳过' },
    { questionItemId: askQuestionId('c', 1), question: '发到哪？', answer: '多行\n"引号"' },
  ]
  const text = askReplyText(replies)
  assert.equal(
    text,
    `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`,
  )
  assert.ok(text.indexOf('questionItemId') < text.indexOf('"question"'))
  assert.deepEqual(parseAskReply(text), replies)
})

test('认得出 codex 自己写的答复（单项、字段按字母排）；格式不对的照原文', () => {
  // 开源 codex 的 AnsweredQuestion::render 的样子（core/tests/suite/snapshots 里的那一份）
  const codex =
    '<send_user_message_question_reply>\n[{"answer":"Customers","question":"Who?","questionItemId":"[\\"request_user_input_async\\",\\"q\\",0]"}]\n</send_user_message_question_reply>'
  assert.deepEqual(parseAskReply(codex), [
    { questionItemId: '["request_user_input_async","q",0]', question: 'Who?', answer: 'Customers' },
  ])
  const one =
    ' <send_user_message_question_reply>{"questionItemId":"x","question":"Q","answer":"A"}</send_user_message_question_reply> '
  assert.deepEqual(parseAskReply(one), [{ questionItemId: 'x', question: 'Q', answer: 'A' }])
  for (const bad of [
    '普通的一句话',
    '<send_user_message_question_reply>[]</send_user_message_question_reply>',
    '<send_user_message_question_reply>[{"questionItemId":"x","question":"Q","answer":"A"},null]</send_user_message_question_reply>',
    '<send_user_message_question_reply>{坏的}</send_user_message_question_reply>',
    '前面有字 <send_user_message_question_reply>{"questionItemId":"x","question":"Q","answer":"A"}</send_user_message_question_reply>',
  ]) {
    assert.equal(parseAskReply(bad), null, bad)
  }
})

test('答复表：只认用户消息里的答复，后答的盖掉先答的，没有新的就是原来那张', () => {
  const id = askQuestionId('c', 0)
  const reply = (answer: string) => askReplyText([{ questionItemId: id, question: 'Q', answer }])
  const empty = {}
  assert.equal(gatherAnswers(empty, [user('u1', '你好')]), empty)
  const first = gatherAnswers(empty, [user('u1', reply('跳过'))])
  assert.deepEqual(first, { [id]: '跳过' })
  assert.equal(gatherAnswers(first, [user('u2', reply('跳过'))]), first)
  assert.deepEqual(gatherAnswers(first, [user('u3', reply('照跑'))]), { [id]: '照跑' })
})

test('卡片的样子：答了一题就算答过；没答的在最后一个回合、会话能发才能答，否则过去了', () => {
  const questions = [
    { id: 'a', title: 'A', options: [] },
    { id: 'b', title: 'B', options: [] },
  ]
  assert.equal(askState(questions, { b: '好' }, false, false), 'answered')
  assert.equal(askState(questions, {}, true, true), 'open')
  assert.equal(askState(questions, {}, false, true), 'closed')
  assert.equal(askState(questions, {}, true, false), 'closed')
})

test('分块：带题的消息是露在外面的卡片，不当最终回答，也不收进过程', () => {
  const ask: ItemView = {
    id: 'q',
    kind: 'agentMessage',
    text: '要不要跳过？',
    phase: 'final',
    status: 'completed',
    delivery: 'async',
    questions: [{ id: askQuestionId('q', 0), title: '要不要跳过？', options: [] }],
  }
  assert.equal(cardPlace(ask), 'outside')
  const { questions: _questions, ...plain } = ask as Extract<ItemView, { kind: 'agentMessage' }>
  assert.equal(cardPlace(plain), null)
  const items = [
    { id: 'u', kind: 'userMessage' as const },
    { id: 'c1', kind: 'command' as const },
    { id: 'q', kind: 'agentMessage' as const, phase: 'final' as const, card: 'outside' as const },
    { id: 'c2', kind: 'command' as const },
  ]
  // 问完接着干活、还没有最终回答：没有回答这一块
  assert.equal(answerOf(items), undefined)
  assert.deepEqual(bucketItems(items), [
    { type: 'user', itemId: 'u' },
    { type: 'process', key: 'c1', parts: [{ type: 'steps', key: 'c1', itemIds: ['c1'] }] },
    { type: 'card', itemId: 'q' },
    { type: 'process', key: 'c2', parts: [{ type: 'steps', key: 'c2', itemIds: ['c2'] }] },
  ])
  const done = [...items, { id: 'a', kind: 'agentMessage' as const, phase: 'final' as const }]
  assert.equal(answerOf(done), 'a')
})
