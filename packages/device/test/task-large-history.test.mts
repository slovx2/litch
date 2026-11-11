// 真实 unix WebSocket（默认 100 MiB）配假引擎：旧路径会把 120 MiB 历史塞进单帧。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { listenUnix, unixConnector } from '../src/sockets.mjs'
import { tempDir } from './helpers.mjs'
import { intervalTask, TaskEngine, taskRig, tasksClient, until } from './task-kit.mjs'

for (const pending of [false, true])
  test(`120MiB 历史：定时任务启动、设备重启恢复${pending ? '在跑' : '已完成'}回合只按页取`, async () => {
    const stateDir = tempDir()
    const engine = new TaskEngine('claude-code')
    const body = 'x'.repeat(1024 * 1024)
    const history = Array.from({ length: 120 }, (_, i) => ({
      id: `old-${i}`,
      status: 'completed',
      items: [{ id: `item-${i}`, type: 'agentMessage', text: body }],
    }))
    engine.threads.push({ id: 'large', updatedAt: 1, status: { type: 'idle' } })
    const turns = () => [
      ...history,
      ...engine.turns.map((turn) => engine.results.get(turn.turnId)).filter(Boolean),
    ]
    engine.handlers['thread/resume'] = (params) => ({
      thread: { id: 'large', status: { type: 'idle' }, turns: params.excludeTurns ? [] : turns() },
    })
    engine.handlers['thread/read'] = (params) => ({
      thread: { id: 'large', status: { type: 'idle' }, turns: params.includeTurns ? turns() : [] },
    })
    engine.handlers['thread/turns/list'] = (params) => {
      const all = turns().reverse(),
        offset = Number(params.cursor ?? 0)
      assert.ok(params.limit <= 10)
      return {
        data: all.slice(offset, offset + params.limit),
        nextCursor: offset + params.limit < all.length ? String(offset + params.limit) : null,
      }
    }
    const original = engine.connector
    const socket = join(stateDir, 'engine.sock')
    const listener = await listenUnix(socket, (wire) => {
      const source = original({ message: (text) => wire.send(text), close: () => wire.close() })
      return {
        message: (text) => {
          void source.then((link) => link.send(text))
        },
        close: () => {
          void source.then((link) => link.close())
        },
      }
    })
    Object.defineProperty(engine, 'connector', { value: unixConnector(socket) })
    engine.script = () => ({ status: null })
    const first = taskRig({ 'claude-code': engine }, { stateDir })
    let second: ReturnType<typeof taskRig> | undefined
    try {
      const client = await tasksClient(first)
      const { task } = await client.call('litch/task/create', {
        ...intervalTask(stateDir),
        target: { kind: 'thread', harness: 'claude-code', threadId: 'large' },
      })
      await client.call('litch/task/runNow', { id: task.id })
      await until('成功启动而非超限失败', async () =>
        ['running', 'failed'].includes(
          (await client.call('litch/task/runs/list', {})).data[0]?.status,
        ),
      )
      const firstRun = (await client.call('litch/task/runs/list', {})).data[0]
      assert.equal(firstRun.status, 'running', firstRun.error?.message)
      assert.equal(engine.turns.length, 1)
      await first.device.close()
      if (!pending) engine.finish(engine.turns[0]!, 'completed', '恢复到了结果')
      second = taskRig({ 'claude-code': engine }, { stateDir }, first.clock)
      const again = await tasksClient(second)
      if (pending) {
        await until(
          '恢复订阅',
          () => engine.seen.filter((row) => row.method === 'thread/resume').length >= 2,
        )
        engine.finish(engine.turns[0]!, 'completed', '恢复到了结果')
      }
      await until(
        '恢复成功且没有重发回合',
        async () => (await again.call('litch/task/runs/list', {})).data[0]?.status === 'succeeded',
      )
      const run = (await again.call('litch/task/runs/list', {})).data[0]
      assert.equal(run.summary, '恢复到了结果')
      assert.equal(engine.turns.length, 1)
      assert.ok(engine.seen.some((row) => row.method === 'thread/turns/list'))
      assert.ok(
        engine.seen
          .filter((row) => row.method === 'thread/resume')
          .every((row) => row.params.excludeTurns === true),
      )
      assert.ok(
        engine.seen
          .filter((row) => row.method === 'thread/read')
          .every((row) => row.params.includeTurns === false),
      )
    } finally {
      await first.device.close()
      await second?.device.close()
      await listener.close()
      const { rmSync } = await import('node:fs')
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

test('恢复分页读取失败保留 interrupted 种类和底层原因，不再发送回合', async () => {
  const { RpcFailure } = await import('./fake-upstream.mjs')
  const engine = new TaskEngine()
  engine.threads.push({ id: 'existing', updatedAt: 1 })
  engine.script = () => ({ status: null })
  const first = taskRig({ pi: engine })
  let second: ReturnType<typeof taskRig> | undefined
  try {
    const client = await tasksClient(first)
    const { task } = await client.call('litch/task/create', {
      ...intervalTask(first.stateDir),
      target: { kind: 'thread', harness: 'pi', threadId: 'existing' },
    })
    await client.call('litch/task/runNow', { id: task.id })
    await until(
      '记好启动',
      async () => (await client.call('litch/task/runs/list', {})).data[0]?.status === 'running',
    )
    await first.device.close()
    engine.handlers['thread/turns/list'] = () => {
      throw new RpcFailure(-32603, 'history read fixture failed')
    }
    second = taskRig({ pi: engine }, { stateDir: first.stateDir }, first.clock)
    const again = await tasksClient(second)
    await until(
      '恢复失败',
      async () => (await again.call('litch/task/runs/list', {})).data[0]?.status === 'failed',
    )
    const run = (await again.call('litch/task/runs/list', {})).data[0]
    assert.equal(run.error.code, 'interrupted')
    assert.match(run.error.message, /history read fixture failed/)
    assert.equal(run.turnId, engine.turns[0]?.turnId)
    assert.equal(engine.turns.length, 1)
  } finally {
    await first.device.close()
    if (second) await second.close()
    else await first.close()
  }
})
