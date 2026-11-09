import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionRecoveryBudget, sessionHistory } from '../src/session-history.mjs'

test('超过100MiB的原生历史只按页读取，保留全部回合顺序与旧待答项', async () => {
  // 逻辑正文共120MiB，复用一个1MiB字符串，不写文件或构造巨大的JSON帧。
  const text = 'x'.repeat(1024 * 1024)
  const turns = Array.from({ length: 120 }, (_, i) => ({
    id: String(i),
    items: [{ type: 'agentMessage', text }],
  }))
  let pages = 0
  const link = {
    native: true,
    async request(method: string, params: any) {
      if (method === 'thread/read') {
        assert.equal(params.includeTurns, false, '完整读取会超过ws默认上限')
        return { thread: { id: 'large', status: { type: 'idle' }, turns: [] } }
      }
      assert.equal(method, 'thread/turns/list')
      assert.equal(params.sortDirection, 'desc')
      assert.equal(params.itemsView, 'full')
      const offset = Number(params.cursor ?? 0)
      pages++
      return {
        data: [...turns].reverse().slice(offset, offset + params.limit),
        nextCursor: offset + params.limit < turns.length ? String(offset + params.limit) : null,
      }
    },
  }
  const full = await sessionHistory(link, 'large', true)
  assert.deepEqual(
    (full.turns as any[]).map((t) => t.id),
    turns.map((t) => t.id),
  )
  assert.equal(pages, 12)
  pages = 0
  const latest = await sessionHistory(link, 'large', true, 1)
  assert.equal(pages, 1)
  assert.deepEqual(
    (latest.turns as any[]).map((t) => t.id),
    ['119'],
  )
})

test('分页游标循环明确失败，不无限读取、不回退整份历史', async () => {
  await assert.rejects(
    sessionHistory(
      {
        native: true,
        async request(method) {
          return method === 'thread/read'
            ? { thread: { id: 'x' } }
            : { data: [], nextCursor: 'repeat' }
        },
      },
      'x',
      true,
    ),
    /游标重复/,
  )
})

test('恢复失败预算按会话保留，指数退避、不并发、到上限停止；其他会话不受影响', () => {
  const budget = new SessionRecoveryBudget([10, 20, 40])
  assert.equal(budget.begin('bad', 0), true)
  assert.equal(budget.begin('bad', 0), false)
  assert.equal(budget.finish('bad', false, 0), 10)
  assert.equal(budget.begin('bad', 9), false)
  assert.equal(budget.begin('bad', 10), true)
  assert.equal(budget.finish('bad', false, 10), 20)
  assert.equal(budget.begin('good', 11), true)
  budget.finish('good', true, 11)
  assert.equal(budget.begin('bad', 30), true)
  assert.equal(budget.finish('bad', false, 30), null)
  assert.equal(budget.begin('bad', 1e10), false)
  assert.equal(budget.begin('good', 1e10), true)
})
