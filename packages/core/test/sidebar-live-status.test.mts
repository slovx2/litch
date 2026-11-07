import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceWorld } from './device-world.mjs'
import { harness } from './fake-device.mjs'
import { agentText, thread, turn, userText } from './fixtures.mjs'
import { settle } from './helpers.mjs'
import { watchSession } from './wire.mjs'

test('从经理建议卡开始的子会话，打开运行历史后补齐目录标记', async () => {
  const child = thread({
    id: 'proposal-child',
    name: '建议创建的工作线',
    status: { type: 'idle' },
    turns: [turn('work', [userText('brief', '执行建议')], { status: 'inProgress' })],
  })
  const codex = harness('codex', { threads: [thread({ id: 'manager', name: '经理' })] })
  const world = deviceWorld([codex], {
    prepare: (device) => device.extensions.push('sessionTree'),
    extra: {
      'litch/sessionProposal/accept': () => {
        codex.threads.push(child)
        world.peer.last().notify('thread/started', { thread: child })
        world.peer.last().notify('litch/thread/lineage/updated', {
          threadId: child.id,
          lineage: {
            parentThreadId: 'manager',
            kind: 'fresh',
            origin: 'proposal',
            title: '建议创建的工作线',
            wakeParent: true,
            reportParent: true,
            createdAt: 1,
          },
        })
        return { threadId: child.id }
      },
    },
  })
  world.core.start()
  await settle()
  let watched: ReturnType<typeof watchSession> | undefined
  try {
    const result = await world.command('session.proposal.accept', {
      sessionId: 'manager',
      proposalId: 'proposal',
    })
    assert.deepEqual(result, { sessionId: child.id })
    assert.equal(world.side.sessions.get(child.id)?.lineage?.parentId, 'manager')
    // 模拟通知/目录仍为空闲、恢复历史却已含运行回合；不靠额外 status 广播补救。
    watched = watchSession(world.core, child.id)
    await settle()
    assert.equal(watched.seen.view?.turns.at(-1)?.status, 'running')
    assert.equal(world.side.sessions.get(child.id)?.status, 'running')
    await world.command('session.markRead', { sessionId: child.id })
    assert.equal(world.side.sessions.get(child.id)?.status, 'running')
  } finally {
    watched?.close()
    world.core.stop()
  }
})

test('运行回合收到经理两次追加消息，侧栏保持运行直到该回合真正完成', async () => {
  const child = thread({ id: 'line', name: '工作线', status: { type: 'idle' } })
  const world = deviceWorld([harness('codex', { threads: [child] })])
  world.core.start()
  await settle()
  const watched = watchSession(world.core, child.id)
  await settle()
  try {
    const peer = world.peer.last()
    peer.notify('turn/started', {
      threadId: child.id,
      turn: turn('work', [], { status: 'inProgress' }),
    })
    await settle()
    assert.equal(world.side.sessions.get(child.id)?.status, 'running')
    for (let index = 1; index <= 2; index++) {
      // send 的 turn/steer 会把追加消息投递为当前回合中的 userMessage，并不结束回合。
      for (const item of [
        userText(`message-${index}`, '经理追加要求'),
        agentText(`reply-${index}`, '继续检查'),
      ]) {
        peer.notify('item/started', { threadId: child.id, turnId: 'work', item })
        peer.notify('item/completed', { threadId: child.id, turnId: 'work', item })
      }
      await settle()
      assert.equal(watched.seen.view?.turns.at(-1)?.status, 'running')
      assert.equal(world.side.sessions.get(child.id)?.status, 'running')
    }
    assert.equal(
      Object.values(watched.seen.view?.items ?? {}).filter((item) => item.kind === 'userMessage')
        .length,
      2,
    )
    peer.notify('turn/completed', { threadId: child.id, turn: turn('work', []) })
    await settle()
    assert.equal(world.side.sessions.get(child.id)?.status, 'idle')
  } finally {
    watched.close()
    world.core.stop()
  }
})

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
