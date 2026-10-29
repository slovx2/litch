import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { approvalHarness } from './approval-harness.mjs'

// 真实 SDK 的自动重试与回合终态：失败的是模型尝试，不能提前认定整个回合失败。
async function setup() {
  const h = await approvalHarness({
    approvals: false,
    prepare: (agentDir) =>
      writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'gate',
          defaultModel: 'gate',
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
        }),
      ),
  })
  const c = await h.connect('desktop')
  const threadId = (await c.ok('thread/start', { cwd: h.cwd, model: 'gate/gate' })).thread.id
  return { h, c, threadId }
}

test('模型首次失败、Pi 自动重试成功：通知与落盘回合都是 completed', async () => {
  const { h, c, threadId } = await setup()
  try {
    h.steps.push({ fail: 'connection terminated' }, { text: '重试成功的回答' })
    const turn = await c.completed(await c.start(threadId, '继续'))
    assert.equal(h.requests.length, 2)
    assert.equal(turn.status, 'completed')
    assert.equal(turn.error, null)
    assert.ok(
      turn.items.some(
        (item: any) => item.type === 'agentMessage' && item.text === '重试成功的回答',
      ),
    )
    const saved = (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns.at(-1)
    assert.equal(saved.status, 'completed')
    assert.equal(saved.error, null)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('自动重试仍失败：保留最后一次模型错误', async () => {
  const { h, c, threadId } = await setup()
  try {
    h.steps.push({ fail: 'connection terminated first' }, { fail: 'connection terminated last' })
    const turn = await c.completed(await c.start(threadId, '继续'))
    assert.equal(h.requests.length, 2)
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /terminated last/)
  } finally {
    await h.dispose()
  }
})

test('模型重试成功不能清除回合的其他错误', async () => {
  const { h, c, threadId } = await setup()
  try {
    h.steps.push({ fail: 'connection terminated' }, () => {
      // 模拟执行期间发现原生会话被别的实例修改；它不是模型的尝试错误。
      const active = h.server.active.get(threadId)
      assert.ok(active)
      active.turn.error = {
        message: '原生会话被外部修改',
        codexErrorInfo: null,
        additionalDetails: null,
      }
      return { text: '模型请求成功' }
    })
    const turn = await c.completed(await c.start(threadId, '继续'))
    assert.equal(turn.status, 'failed')
    assert.equal(turn.error.message, '原生会话被外部修改')
  } finally {
    await h.dispose()
  }
})
