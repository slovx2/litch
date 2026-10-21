import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { approvalHarness, type Step } from './approval-harness.mjs'

// 上下文满了的回合。Pi 把这些当成可恢复的、回合照常结束：模型一个字都没写出来就停在输出上限上
// （上下文满了时 Pi 把输出上限压到只剩十几个词元），Pi 去掉这条空回复、自动压缩再接着做；
// 自动压缩失败了照样往下请求，原因只在 compaction_end 事件里。入口要把这些报成回合失败、写明原因，
// 压成了接着做完的照常是完成。真实 Pi SDK 加回环上的假模型（上下文 32000，压缩的阈值是 32000 − 16384）。

/** 写摘要的请求（整段历史的、切开的那一轮前半段的）：Pi 把对话序列化成文字交给模型 */
const summarizing = (body: any) => /<conversation>|# Conversation\n/.test(JSON.stringify(body))

/** keep：压缩时留下最近多少个词元不压；0 是一轮说完就有东西可压 */
async function setup(keep?: number) {
  const h = await approvalHarness({
    approvals: false,
    prepare: async (agentDir) => {
      await writeFile(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'gate',
          defaultModel: 'gate',
          retry: { enabled: false },
          ...(keep === undefined ? {} : { compaction: { keepRecentTokens: keep } }),
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

test('一个字都没写出来就停在输出上限上、也没东西可压：回合失败，写明上下文满了；之后照常能用', async () => {
  const { h, c, threadId, say } = await setup()
  try {
    h.steps.push({ length: true })
    const turn = await say('头一句')
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /^上下文满了：模型的回答被截断/)
    const history = (await c.ok('thread/read', { threadId, includeTurns: true })).thread.turns
    assert.equal(history.at(-1).status, 'failed')
    assert.equal(history.at(-1).error.message, turn.error.message)
    h.steps.length = 0
    assert.equal((await say('接着说')).status, 'completed')
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('截断之后自动压缩失败：回合失败，错误里是 Pi 给的失败原因', async () => {
  const { h, say } = await setup(0)
  try {
    assert.equal((await say('头一轮')).status, 'completed')
    h.steps.push({ length: true }, { fail: '模拟的摘要故障' }, { fail: '模拟的摘要故障' })
    const turn = await say('第二轮')
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /^上下文满了，自动压缩失败：.*模拟的摘要故障/)
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('截断之后压成了、Pi 接着做完：回合照常完成，有压缩条目和后来的回答', async () => {
  const { h, say } = await setup(0)
  try {
    assert.equal((await say('头一轮')).status, 'completed')
    const after: Step = (body) => (summarizing(body) ? { text: '摘要' } : { text: '压完接着答' })
    h.steps.push({ length: true }, after, after, after)
    const turn = await say('第二轮')
    assert.equal(turn.status, 'completed', JSON.stringify(turn.error))
    assert.equal(turn.error, null)
    const types = turn.items.map((item: any) => item.type)
    assert.ok(types.includes('contextCompaction'), JSON.stringify(types))
    assert.ok(
      turn.items.some((item: any) => item.type === 'agentMessage' && item.text === '压完接着答'),
      JSON.stringify(turn.items),
    )
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})

test('回答写完了、过了阈值的自动压缩失败：回答留着，回合失败，写明上下文快满了和原因', async () => {
  const { h, say } = await setup(0)
  try {
    assert.equal((await say('头一轮')).status, 'completed')
    h.steps.push(
      { text: '答好了', promptTokens: 20000 },
      { fail: '模拟的摘要故障' },
      { fail: '模拟的摘要故障' },
    )
    const turn = await say('第二轮')
    assert.equal(turn.status, 'failed')
    assert.match(turn.error.message, /^上下文快满了，自动压缩失败：.*模拟的摘要故障/)
    assert.ok(
      turn.items.some((item: any) => item.type === 'agentMessage' && item.text === '答好了'),
      JSON.stringify(turn.items),
    )
    assert.deepEqual(h.invalid, [])
  } finally {
    await h.dispose()
  }
})
