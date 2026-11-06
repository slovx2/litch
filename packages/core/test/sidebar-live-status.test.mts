import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { thread, turn } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

test('正在查看的 Codex 工作线收到回合事件时，侧栏与对话同步运行状态', async () => {
  const line = thread({ id: 'line', name: '小修复长线', status: { type: 'idle' }, turns: [] })
  const world = deviceWorld([harness('codex', { threads: [line] })])
  world.core.start()
  await settle()
  const session = watchSession(world.core, line.id)
  await settle()
  try {
    const peer = world.peer.last()
    peer.notify('turn/started', {
      threadId: line.id,
      turn: turn('work', [], { status: 'inProgress' }),
    })
    await settle()
    assert.equal(session.seen.view?.turns.at(-1)?.status, 'running')
    assert.equal(world.side.sessions.get(line.id)?.status, 'running')
    await world.command('session.markRead', { sessionId: line.id })
    assert.equal(world.side.sessions.get(line.id)?.status, 'running')
    peer.notify('thread/status/changed', {
      threadId: line.id,
      status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    })
    await settle()
    assert.equal(world.side.sessions.get(line.id)?.status, 'waiting')
    peer.notify('litch/thread/background/changed', {
      threadId: line.id,
      tasks: [{ id: 'shell', kind: 'shell', title: '后台构建', status: 'running', startedAt: 1 }],
      wakesOnFinish: true,
    })
    // 重放同一回合的 started 不能抹掉更具体的等待状态。
    peer.notify('turn/started', {
      threadId: line.id,
      turn: turn('work', [], { status: 'inProgress' }),
    })
    await settle()
    assert.equal(world.side.sessions.get(line.id)?.status, 'waiting')
    peer.notify('turn/completed', { threadId: line.id, turn: turn('work', []) })
    await settle()
    assert.equal(session.seen.view?.turns.at(-1)?.status, 'completed')
    assert.equal(world.side.sessions.get(line.id)?.status, 'idle')
    assert.equal(world.side.sessions.get(line.id)?.background?.running, 1, '回合结束不清除后台任务')
  } finally {
    session.close()
    world.core.stop()
  }
})

test('打开运行中的历史补齐侧栏；较早回合结束不能清掉较新回合的运行标记', async () => {
  const running = turn('new', [], { status: 'inProgress' })
  const line = thread({ id: 'line', status: { type: 'idle' }, turns: [running] })
  const world = deviceWorld([harness('codex', { threads: [line] })])
  world.core.start()
  await settle()
  const session = watchSession(world.core, line.id)
  await settle()
  try {
    assert.equal(session.seen.view?.turns.at(-1)?.status, 'running')
    assert.equal(world.side.sessions.get(line.id)?.status, 'running')
    world.peer.last().notify('turn/completed', { threadId: line.id, turn: turn('old', []) })
    await settle()
    assert.equal(world.side.sessions.get(line.id)?.status, 'running')
  } finally {
    session.close()
    world.core.stop()
  }
})
