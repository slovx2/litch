import assert from 'node:assert/strict'
import test from 'node:test'
import { type OcThread, Projection, type ProjectionHooks } from '../src/projection.mjs'

// 压缩条目的开始和完成（照上游）：带压缩部件的用户消息一到就是开始压，写摘要的那条助手消息写完了才是压完；
// 没写完回合就结束了不发完成，客户端当它没压完。直接喂 OpenCode 的事件，不起 OpenCode。

const thread: OcThread = {
  id: 'ses_1',
  cwd: '/tmp',
  title: '',
  name: null,
  preview: '',
  createdAt: 0,
  updatedAt: 0,
  parentThreadId: null,
  agent: null,
  ephemeral: false,
}

const hooks: ProjectionHooks = {
  recorded: () => null,
  steer: () => false,
  contextWindow: () => null,
  mcpServers: () => [],
  dynamicTool: () => null,
  dynamicToolStarted: () => {},
  selfStarted: () => false,
}

function scene() {
  const sent: { method: string; params: any }[] = []
  const notify = (method: string, params: any) => sent.push({ method, params })
  const projection = new Projection({ ...thread }, hooks)
  const user = { id: 'msg_1', role: 'user', sessionID: thread.id, time: { created: 1 } }
  projection.message(user, notify, true)
  projection.part(
    { id: 'prt_c', type: 'compaction', messageID: 'msg_1', sessionID: thread.id, auto: false },
    notify,
  )
  const summary = {
    id: 'msg_2',
    role: 'assistant',
    parentID: 'msg_1',
    sessionID: thread.id,
    summary: true,
    time: { created: 2 },
  }
  projection.message(summary, notify)
  const compaction = (method: string) =>
    sent.filter((n) => n.method === method && n.params.item?.type === 'contextCompaction')
  return { projection, notify, summary, compaction }
}

test('OpenCode 压缩：开始压就发开始，摘要写完才发完成', () => {
  const { projection, notify, summary, compaction } = scene()
  assert.equal(compaction('item/started').length, 1)
  assert.equal(compaction('item/completed').length, 0)
  projection.message({ ...summary, time: { created: 2, completed: 3 } }, notify)
  assert.deepEqual(
    compaction('item/completed').map((n) => n.params.item.id),
    ['prt_c'],
  )
  projection.idle(notify, 4)
  assert.equal(compaction('item/completed').length, 1)
})

test('OpenCode 压缩：摘要出错、回合结束，不发完成', () => {
  const { projection, notify, summary, compaction } = scene()
  projection.message(
    {
      ...summary,
      error: { name: 'APIError', data: { message: '摘要失败' } },
      time: { created: 2, completed: 3 },
    },
    notify,
  )
  projection.idle(notify, 4)
  assert.equal(compaction('item/started').length, 1)
  assert.equal(compaction('item/completed').length, 0)
  const ended = projection.turns.at(-1)
  assert.equal(ended?.status, 'failed')
})
