import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CoreChannel, TopicSink } from '../src/channel/client.mjs'
import { askReplyText } from '../src/projection/asks.mjs'
import { projectThread } from '../src/projection/session.mjs'
import { createReplica, keys } from '../src/replica/replica.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { longCommandView } from './long-command-fixture.mjs'

function receiver() {
  let sink!: TopicSink<'session'>
  const channel: CoreChannel = {
    async command() {
      throw new Error('本用例不发送命令')
    },
    subscribe(_topic, receiver) {
      sink = receiver as TopicSink<'session'>
      return () => {}
    },
    close() {},
  }
  const replica = createReplica(channel)
  replica.openSession('local', 'long-latency')
  return { replica, sink }
}

test('70MB 合成长会话批量回退：重建答复索引只扫描一次，状态库读取量不随删除回合数乘上历史条目数', () => {
  const { view, counts } = longCommandView()
  assert.equal(counts.turns, 1265)
  assert.equal(counts.tools, 4515)
  assert.equal(counts.compactions, 18)
  assert.equal(counts.maxTurnItems, 268)
  const { replica, sink } = receiver()
  sink.snapshot(view)
  const original = replica.store.get.bind(replica.store)
  let reads = 0
  replica.store.get = <T,>(key: string) => {
    reads++
    return original<T>(key)
  }
  let notifications = 0
  replica.store.subscribe(keys.turnIds('local', 'long-latency'), () => notifications++)
  sink.delta(view.turns.slice(20).map((turn) => ({ op: 'turn.remove', turnId: turn.id })))
  assert.ok(reads < 5000, `一次批量删除读取了 ${reads} 次，旧实现约 744 万次`)
  assert.equal(notifications, 1)
  assert.equal(replica.store.get<string[]>(keys.turnIds('local', 'long-latency'))?.length, 20)
  assert.ok(replica.store.get(keys.item('local', 'long-latency', 't19:u19')))
  assert.equal(replica.store.get(keys.item('local', 'long-latency', 't20:u20')), undefined)
})

test('同批删除最新答复、添加再删除及重加回合：按最终历史顺序重建答案，不泄露中间状态', () => {
  const reply = (answer: string) =>
    askReplyText([{ questionItemId: 'q', question: '合成问题', answer }])
  const view = projectThread(
    thread({
      id: 'long-latency',
      turns: [
        turn('t0', [userText('u', reply('旧答案')), agentText('a', '旧回答')]),
        turn('t1', [userText('u', reply('新答案'))]),
      ],
    }),
    { deviceId: 'local', harness: 'claude' },
  )
  const { replica, sink } = receiver()
  sink.snapshot(view)
  const answers = () => replica.store.get(keys.answers('local', 'long-latency'))
  assert.deepEqual(answers(), { q: '新答案' })
  const seen: unknown[] = []
  replica.store.subscribe(keys.answers('local', 'long-latency'), () => seen.push(answers()))
  sink.delta([
    { op: 'turn.remove', turnId: 't1' },
    {
      op: 'item.add',
      turnId: 't0',
      item: { id: 'temporary', kind: 'userMessage', text: reply('临时答案'), attachments: [] },
    },
    { op: 'item.remove', turnId: 't0', itemId: 'temporary' },
  ])
  assert.deepEqual(seen, [{ q: '旧答案' }])
  const first = view.turns[0]
  assert.ok(first)
  sink.delta([
    { op: 'turn.remove', turnId: 't0' },
    { op: 'turn.add', turn: { ...first, itemIds: [] } },
    {
      op: 'item.add',
      turnId: 't0',
      item: { id: 'replacement', kind: 'userMessage', text: reply('替换答案'), attachments: [] },
    },
  ])
  assert.deepEqual(answers(), { q: '替换答案' })
  sink.delta([{ op: 'item.remove', turnId: 't0', itemId: 'replacement' }])
  assert.deepEqual(answers(), {})
})
