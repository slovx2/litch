import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { RpcPeer, WireMessage } from '../../shared/src/types.mjs'
import { PiServer } from '../src/server.mjs'
import { approvalHarness } from './approval-harness.mjs'
import { assertResponse } from './schema.mjs'

// 手动压缩（thread/compact/start）。Pi 自己定压不压：会话太小它不压，这不是出错，
// 不开回合、原话作为请求的错误回去；定了要压才开回合，压缩出错是这个回合失败。
// 真实 Pi SDK 加回环上的假模型。

const SUMMARY = '压缩出来的摘要 SUMMARY-9'

/** keep：压缩时留下最近多少个词元不压；0 是一轮说完就有东西可压 */
async function setup(keep?: number) {
  const h = await approvalHarness({
    approvals: false,
    prepare: async (agentDir) => {
      if (keep === undefined) return
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'gate',
          defaultModel: 'gate',
          retry: { enabled: false },
          compaction: { keepRecentTokens: keep },
        }),
      )
    },
  })
  const c = await h.connect('desktop')
  const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
  const say = async (words: string) => {
    const turnId = (await c.ok('turn/start', { threadId, input: [{ type: 'text', text: words }] }))
      .turn.id
    return c.completed(turnId)
  }
  return { h, c, threadId, say }
}

test('会话太小、Pi 不压：请求报错，不开回合，历史里什么都不留', async () => {
  const { h, c, threadId, say } = await setup()
  try {
    // 一句话都没说过的，和说过一轮的，都太小
    for (const before of [0, 1]) {
      if (before) assert.equal((await say('说一句')).status, 'completed')
      const turns = (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns
      const sent = c.messages.length
      const reply = await c.call('thread/compact/start', { threadId })
      assert.equal(reply.error?.code, -32600, JSON.stringify(reply))
      assert.match(reply.error.message, /Nothing to compact/)
      assert.deepEqual(
        c.messages.slice(sent).filter((m: any) => m.method?.startsWith('turn/')),
        [],
        '没压也开了回合',
      )
      const after = (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns
      assert.deepEqual(after, turns)
    }
    // 会话照常能用
    assert.equal((await say('接着说')).status, 'completed')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('真的压了：单独一个回合，只有“上下文已压缩”；之后接着聊，模型拿到的是摘要', async () => {
  const { h, c, threadId, say } = await setup(0)
  try {
    assert.equal((await say('头一轮 OLD-1')).status, 'completed')
    // 压缩时 Pi 请模型写摘要（一轮切在中间时还有一次前半轮的摘要），都回同一句
    h.steps.push({ text: SUMMARY }, { text: SUMMARY })
    const sent = c.messages.length
    assert.deepEqual(await c.ok('thread/compact/start', { threadId }), {})
    const started = await c.until(
      '压缩的回合开始',
      (m: any) => m.method === 'turn/started' && c.messages.indexOf(m) >= sent,
    )
    const turn = await c.completed(started.params.turn.id)
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    assert.deepEqual(
      turn.items.map((item: any) => item.type),
      ['contextCompaction'],
    )
    const history = (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns
    assert.deepEqual(
      { id: history.at(-1).id, status: history.at(-1).status, items: history.at(-1).items },
      { id: turn.id, status: 'completed', items: turn.items },
    )
    // 压完接着聊：模型收到的是摘要，不再是压掉的原话
    const asked = h.requests.length
    assert.equal((await say('压完接着说')).status, 'completed')
    const context = JSON.stringify(h.requests.slice(asked).at(-1).messages)
    assert.ok(context.includes(SUMMARY), '压缩之后模型没拿到摘要')
    assert.ok(!context.includes('OLD-1'), '压掉的原话还在模型的上下文里')
    // 换一个适配器进程，从原生会话重新读出来：压缩的回合还是那样
    await h.shutdown()
    const again = new PiServer(join(h.root, 'state'))
    try {
      const got: any[] = []
      const peer: RpcPeer = { id: 'again', close() {}, send: (m: WireMessage) => got.push(m) }
      await again.handle(peer, {
        jsonrpc: '2.0',
        id: 1,
        method: 'thread/read',
        params: { threadId, includeTurns: true },
      })
      const read = got.find((m) => m.id === 1)
      assertResponse('thread/read', read.result)
      const compacted = read.result.thread.turns.find((t: any) => t.id === turn.id)
      assert.deepEqual(
        compacted.items.map((item: any) => item.type),
        ['contextCompaction'],
      )
      assert.equal(compacted.status, 'completed')
    } finally {
      await again.close()
    }
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('压缩时模型请求失败：开了回合，这个回合失败，和“太小不压”分得开', async () => {
  const { h, c, threadId, say } = await setup(0)
  try {
    assert.equal((await say('头一轮')).status, 'completed')
    h.steps.push({ fail: '模拟的模型故障' }, { fail: '模拟的模型故障' })
    const sent = c.messages.length
    assert.deepEqual(await c.ok('thread/compact/start', { threadId }), {})
    const started = await c.until(
      '压缩的回合开始',
      (m: any) => m.method === 'turn/started' && c.messages.indexOf(m) >= sent,
    )
    const turn = await c.completed(started.params.turn.id)
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /模拟的模型故障/)
    assert.deepEqual(turn.items, [])
    // 两段摘要可能同时请求，也可能头一段失败就不请求第二段：没用上的步骤不留给后面
    h.steps.length = 0
    const history = (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns
    assert.equal(history.at(-1).status, 'failed')
    // 失败了不影响接着用
    assert.equal((await say('接着说')).status, 'completed')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})
