// 完成接续还在等仲裁时，定时运行不能按旧的短等待窗口提前丢失后续摘要。
import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineLink } from '../src/engine-link.mjs'
import { type FollowUpdate, followBackground } from '../src/task-follow.mjs'

test('NATIVE-WAKE-FOLLOW 等待接续撤销旧收尾计时器，续跑摘要写回定时运行', async () => {
  let listener: (method: string, params: unknown) => void = () => {}
  let closed = false
  let pending = false
  let wakes = true
  const patches: FollowUpdate[] = []
  const link = {
    onNotification: (fn: typeof listener) => {
      listener = fn
      return () => {
        listener = () => {}
      }
    },
    onClose: () => () => {},
    close: () => {
      closed = true
    },
  } as unknown as EngineLink
  const stop = followBackground(
    {
      now: Date.now,
      limitMs: 2000,
      settleMs: 10,
      backgroundRunning: () => 0,
      backgroundWakes: () => wakes,
      continuationPending: () => pending,
      summaryOf: (text) => text,
      log: () => {},
    },
    link,
    'thread',
    (patch) => patches.push(patch),
  )
  try {
    pending = true
    listener('item/completed', { threadId: 'thread', item: { type: 'commandExecution' } })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(closed, false)
    listener('turn/started', { threadId: 'thread', turn: { id: 'wake' } })
    listener('item/completed', {
      threadId: 'thread',
      turnId: 'wake',
      item: { type: 'agentMessage', text: '测试通过' },
    })
    pending = false
    wakes = false
    listener('turn/completed', {
      threadId: 'thread',
      turn: { id: 'wake', litchOrigin: 'backgroundTask' },
    })
    assert.deepEqual(patches, [{ summary: '测试通过', backgroundTasks: 0 }])
    assert.equal(closed, true)
  } finally {
    stop()
  }
})
