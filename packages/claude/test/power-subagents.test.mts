import assert from 'node:assert/strict'
import test from 'node:test'
import { openStage } from './fixtures/in-process.mjs'

test('POWER-CLAUDE-005：恢复包含内存中的子代理活动，结束后定向核对为不活动', async () => {
  const stage = await openStage('power-subagent', { native: null })
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  try {
    const owner = await stage.connect('owner')
    const { thread } = await owner.request('thread/start', { cwd: stage.directory })
    stage.script = async (_context, handlers) => {
      await handlers.onEvent({
        type: 'tool_use',
        toolUseId: 'task',
        toolName: 'Task',
        input: { description: 'mock', prompt: 'mock' },
      })
      started()
      await gate
      await handlers.onEvent({ type: 'tool_result', toolUseId: 'task', content: 'completed' })
      await handlers.onEvent({ type: 'completed', success: true })
    }
    const { turn } = await owner.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'mock' }],
    })
    await Promise.race([
      ready,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('子代理启动超时')), 5000).unref(),
      ),
    ])
    const child = (
      await owner.notification(
        'thread/started',
        (params) => params.thread.threadSource === 'subagent',
      )
    ).params.thread
    const observer = await stage.connect('litch-power-observer')
    const method = 'litch/internal/power/activity'
    const snapshot = await observer.request(method)
    assert.deepEqual(
      snapshot.threads.map((entry: { threadId: string }) => entry.threadId).sort(),
      [thread.id, child.id].sort(),
    )
    assert.deepEqual(await observer.request(method, { threadIds: [child.id] }), {
      threads: [{ threadId: child.id, active: true, background: false }],
    })
    release()
    await owner.completed(turn.id)
    assert.deepEqual(await observer.request(method, { threadIds: [child.id] }), {
      threads: [{ threadId: child.id, active: false, background: false }],
    })
  } finally {
    release()
    await stage.dispose()
  }
})
