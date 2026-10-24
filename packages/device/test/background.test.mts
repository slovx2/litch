// 后台任务（backgroundTasks 扩展）：原生 codex 的集合由设备进程从条目通知里派生；
// 引擎报的原样转发，设备进程记一份给会话树、定时任务的回报数后台任务。
import assert from 'node:assert/strict'
import test from 'node:test'
import { DeviceBackground } from '../src/background.mjs'
import { codexRig } from './codex-kit.mjs'
import { codexThread } from './fake-codex.mjs'
import { settle } from './helpers.mjs'

const CHANGED = 'litch/thread/background/changed'

function command(id: string, status: string, exitCode: number | null = null) {
  return { type: 'commandExecution', id, command: `npm run ${id}`, status, exitCode }
}

test('BG-DEVICE-001 派生：回合结束时还 inProgress 的命令进集合，item/completed 结束，卸载时还在跑的记 stopped', () => {
  const sent: any[] = []
  let clock = 1_000
  const background = new DeviceBackground({
    announce: (method, params, extension) => sent.push({ method, params, extension }),
    now: () => clock,
  })
  const t = 't1'
  background.codexNotification('item/started', {
    threadId: t,
    turnId: 'u1',
    item: command('dev', 'inProgress'),
  })
  background.codexNotification('item/started', {
    threadId: t,
    turnId: 'u1',
    item: command('test', 'inProgress'),
  })
  // 回合里结束的命令不进集合
  background.codexNotification('item/completed', {
    threadId: t,
    turnId: 'u1',
    item: command('test', 'completed', 0),
  })
  assert.equal(sent.length, 0)
  clock = 2_000
  background.codexNotification('turn/completed', {
    threadId: t,
    turn: { id: 'u1', status: 'completed' },
  })
  // 同一条通知经别的连接再来一份：不重发
  background.codexNotification('turn/completed', {
    threadId: t,
    turn: { id: 'u1', status: 'completed' },
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].method, CHANGED)
  assert.equal(sent[0].extension, 'backgroundTasks')
  assert.deepEqual(sent[0].params, {
    threadId: t,
    tasks: [
      {
        id: 'dev',
        kind: 'shell',
        title: 'npm run dev',
        status: 'running',
        itemId: 'dev',
        turnId: 'u1',
        startedAt: 1_000,
      },
    ],
    wakesOnFinish: false,
  })
  assert.equal(background.running(t), 1)
  const thread: Record<string, unknown> = { id: t }
  background.decorate(thread)
  assert.equal((thread.litchBackground as any).tasks[0].status, 'running')

  // 退出码非零记 failed
  clock = 3_000
  background.codexNotification('item/completed', {
    threadId: t,
    turnId: 'u1',
    item: command('dev', 'completed', 1),
    completedAtMs: 2_500,
  })
  assert.equal(sent.at(-1).params.tasks[0].status, 'failed')
  assert.equal(sent.at(-1).params.tasks[0].endedAt, 2_500)
  assert.equal(background.running(t), 0)

  // 卸载会话：还在跑的记 stopped
  background.codexNotification('item/started', {
    threadId: t,
    turnId: 'u2',
    item: command('serve', 'inProgress'),
  })
  background.codexNotification('turn/completed', {
    threadId: t,
    turn: { id: 'u2', status: 'completed' },
  })
  background.codexNotification('thread/status/changed', {
    threadId: t,
    status: { type: 'notLoaded' },
  })
  assert.deepEqual(
    sent.at(-1).params.tasks.map((task: any) => [task.id, task.status]),
    [
      ['serve', 'stopped'],
      ['dev', 'failed'],
    ],
  )

  // 引擎报的只记数
  background.reportedChanged({
    threadId: 'c1',
    tasks: [{ id: 'b', kind: 'shell', title: 'x', status: 'running' }],
    wakesOnFinish: true,
  })
  assert.equal(background.running('c1'), 1)
})

test('BG-DEVICE-004 派生：用户经 terminate（按 processId）、clean（全部）停掉的命令记 stopped，不按退出码记 failed', () => {
  const background = new DeviceBackground({ announce: () => {}, now: () => 1_000 })
  const t = 't1'
  const run = (id: string) => ({ ...command(id, 'inProgress'), processId: `proc-${id}` })
  for (const id of ['dev', 'serve', 'watch'])
    background.codexNotification('item/started', { threadId: t, turnId: 'u1', item: run(id) })
  background.codexNotification('turn/completed', {
    threadId: t,
    turn: { id: 'u1', status: 'completed' },
  })
  const end = (id: string, exitCode: number) =>
    background.codexNotification('item/completed', {
      threadId: t,
      turnId: 'u1',
      item: { ...command(id, 'failed', exitCode), processId: `proc-${id}` },
    })
  background.userStopped(t, 'proc-dev')
  end('dev', 143)
  // 没点停止的照退出码记
  end('serve', 1)
  background.userStopped(t, null)
  end('watch', 137)
  assert.deepEqual(Object.fromEntries(background.tasks(t).map((task) => [task.id, task.status])), {
    dev: 'stopped',
    serve: 'failed',
    watch: 'stopped',
  })
  // 没有派生集合的会话（适配器的引擎自己报）：不记
  background.userStopped('other', 'p')
  assert.deepEqual(background.tasks('other'), [])
})

test('BG-DEVICE-002 恢复时从历史补：最后一个进行中的回合不算，核过后台终端列表的才算', () => {
  const sent: any[] = []
  const background = new DeviceBackground({
    announce: (method, params) => sent.push({ method, params }),
  })
  const candidates = background.codexResumed({
    id: 't2',
    turns: [
      {
        id: 'u1',
        status: 'completed',
        startedAt: 10,
        items: [
          command('a', 'inProgress'),
          command('b', 'inProgress'),
          command('c', 'completed', 0),
        ],
      },
      { id: 'u2', status: 'inProgress', startedAt: 20, items: [command('d', 'inProgress')] },
    ],
  })
  assert.deepEqual(candidates, ['a', 'b'])
  // b 已经没了（原生 codex 重启过）
  background.codexConfirmed('t2', candidates, new Set(['a']))
  assert.deepEqual(
    sent.at(-1).params.tasks.map((task: any) => [task.id, task.startedAt]),
    [['a', 10_000]],
  )
})

test('BG-DEVICE-003 聚合面：声明了的连接收到原生 codex 的集合，会话对象上带着；没声明的什么都没有', async () => {
  const thread = codexThread(1, 400)
  const env = codexRig()
  try {
    const declared = env.connect()
    await declared.initialize(['harness', 'backgroundTasks'])
    const plain = env.connect()
    await plain.initialize(['harness'])
    const info = await declared.call('runtime/info')
    assert.equal(
      info.harnesses.find((item: any) => item.id === 'codex').features.backgroundTasks,
      true,
    )
    assert.equal(
      info.harnesses.find((item: any) => item.id === 'codex').features.stopBackground,
      true,
    )
    await declared.call('thread/resume', { threadId: thread.id })
    await settle()
    env.codex.notify('item/started', {
      threadId: thread.id,
      turnId: 'u1',
      item: command('dev', 'inProgress'),
    })
    env.codex.notify('turn/completed', {
      threadId: thread.id,
      turn: { id: 'u1', status: 'completed', items: [] },
    })
    const changed: any = await declared.waitFor((frame) => frame.method === CHANGED)
    assert.equal(changed.params.threadId, thread.id)
    assert.equal(changed.params.tasks[0].status, 'running')
    const list = await declared.call('thread/list', { limit: 10 })
    const row = list.data.find((item: any) => item.id === thread.id)
    assert.equal(row.litchBackground.tasks[0].title, 'npm run dev')
    const plainList = await plain.call('thread/list', { limit: 10 })
    assert.equal(
      plainList.data.find((item: any) => item.id === thread.id).litchBackground,
      undefined,
    )
    env.codex.notify('item/completed', {
      threadId: thread.id,
      turnId: 'u1',
      item: command('dev', 'completed', 0),
    })
    await declared.waitFor(
      (frame: any) => frame.method === CHANGED && frame.params.tasks[0].status === 'completed',
    )
    await settle()
    assert.equal(plain.notifications.filter((frame) => frame.method === CHANGED).length, 0)
  } finally {
    await env.close()
  }
})
