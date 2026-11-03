import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wrapQuestionId } from '../../protocol/src/pending-asks.mjs'
import type { ItemView, TurnView, UserMessageItem } from '../src/model.mjs'
import { adjacentAskReply, askReplySource } from '../src/projection/ask-reply.mjs'
import { askQuestionId, askReplyText, gatherAnswers } from '../src/projection/asks.mjs'
import { blockInput, bucketItems } from '../src/projection/blocks.mjs'
import { projectTurn } from '../src/projection/session.mjs'
import { searchCardItem } from '../src/search/cards.mjs'
import { turn as protocolTurn } from './fixtures.mjs'

const title = '下一步做什么？'
const answer = '先练级和做其他事情'
const question: ItemView = {
  id: 'q',
  kind: 'agentMessage',
  text: '',
  phase: 'commentary',
  status: 'completed',
  questions: [{ id: askQuestionId('q', 0), title, options: [] }],
}
const reply: UserMessageItem = {
  id: 'reply',
  kind: 'userMessage',
  attachments: [],
  text: askReplyText([{ questionItemId: askQuestionId('q', 0), question: title, answer }]),
}
const peer: UserMessageItem = {
  id: 'peer',
  kind: 'userMessage',
  attachments: [],
  text: '补齐证据',
  peer: { name: '基建', session: 'other', bypass: false },
}
const process: ItemView = {
  id: 'process',
  kind: 'reasoning',
  text: '继续处理',
  status: 'completed',
}
const continued: ItemView = {
  id: 'continued',
  kind: 'agentMessage',
  text: '已记下决定',
  phase: 'commentary',
  status: 'inProgress',
}
const view = (items: ItemView[], status: TurnView['status'] = 'running'): TurnView => ({
  id: 'turn',
  status,
  itemIds: items.map((item) => item.id),
  startedAt: null,
  durationMs: null,
  error: null,
})

test('原问题紧邻答复才合并；消息、过程与回合边界隔开时保留答复', () => {
  for (const status of ['running', 'completed'] as const) {
    for (const middle of [[], [peer], [process]]) {
      const items: ItemView[] = [question, ...middle, reply, continued]
      const itemOf = (id: string): ItemView | undefined => items.find((item) => item.id === id)
      const turn = view(items, status)
      const folded = adjacentAskReply(reply, turn, itemOf)
      assert.equal(folded, middle.length === 0)
      assert.equal(searchCardItem(reply, {}, new Set(), folded) === null, folded)
      assert.deepEqual(askReplySource(askQuestionId('q', 0), [turn], itemOf), {
        itemId: 'q',
        turnId: 'turn',
      })
      assert.equal(adjacentAskReply(reply, view([reply, continued], status), itemOf), false)
    }
  }
})

test('插入会话消息与答复的两种顺序都独立保留，重新投影结果相同', () => {
  for (const inserts of [
    [reply, peer],
    [peer, reply],
  ]) {
    const items: ItemView[] = [question, process, ...inserts, continued]
    for (const values of [items, structuredClone(items)]) {
      const turn = view(values)
      const itemOf = (id: string): ItemView | undefined => values.find((item) => item.id === id)
      assert.equal(adjacentAskReply(reply, turn, itemOf), false)
      assert.deepEqual(gatherAnswers({}, values), { [askQuestionId('q', 0)]: answer })
      const users = bucketItems(
        values.map((item) => blockInput(item.id, item)),
        { turnRunning: true },
      )
        .filter((block) => block.type === 'user')
        .map((block) => block.itemId)
      assert.deepEqual(
        users,
        inserts.map((item) => item.id),
      )
    }
  }
})

test('wind 的上一回合收尾题：答案保留在新回合，按稳定题号可跳回原卡', () => {
  const source = protocolTurn('old', [
    {
      type: 'dynamicToolCall',
      id: 'wrap',
      namespace: 'litch_sessions',
      tool: 'wrap_up',
      arguments: { suggestions: [], ask: title },
      status: 'completed',
      contentItems: [],
      success: true,
      durationMs: 0,
    },
  ])
  const first = projectTurn(source)
  const questionId = wrapQuestionId('old:wrap')
  const response = {
    ...reply,
    text: askReplyText([{ questionItemId: questionId, question: title, answer }]),
  }
  for (const order of [
    [response, peer],
    [peer, response],
  ]) {
    const current = view(order)
    const all = [...first.items, ...order]
    const itemOf = (id: string) => all.find((item) => item.id === id)
    assert.equal(adjacentAskReply(response, current, itemOf), false)
    assert.deepEqual(askReplySource(questionId, [first.turn, current], itemOf), {
      itemId: 'old:wrap',
      turnId: 'old',
    })
    assert.equal(gatherAnswers({}, all)[questionId], answer)
  }
})

test('相同题面不混淆来源；缺失来源、附件与会话消息都不隐藏', () => {
  const items = [question, reply]
  const itemOf = (id: string) => items.find((item) => item.id === id)
  assert.equal(askReplySource('missing', [view(items)], itemOf), null)
  assert.equal(
    adjacentAskReply(
      { ...reply, peer: { name: '基建', session: 'other', bypass: false } },
      view(items),
      itemOf,
    ),
    false,
  )
  assert.equal(
    adjacentAskReply(
      { ...reply, text: askReplyText([{ questionItemId: 'missing', question: title, answer }]) },
      view(items),
      itemOf,
    ),
    false,
  )
})
