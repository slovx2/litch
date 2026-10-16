// 终端会话，属于设备的那一种：断线之后挂回、应用重开之后按标记恢复成标签、列表跟着设备上的增减变、
// 关标签的两种意思（留在设备上、结束）、退出应用前的清点。搭建见 terminal-world.mts。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChannelError } from '../src/index.mjs'
import { terminalWorld, watchTerminal, watchTerminals } from './terminal-world.mjs'

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('断线再连回：进程还在，从手里的偏移往后补，补了多少有记号；没人看的不去取', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const watched = await world.open()
  const unwatched = await world.open()
  const view = watchTerminal(world.core, watched)
  world.procs.emit(watched, 'before\r\n')
  world.procs.emit(unwatched, 'nobody reads this\r\n')
  await world.idle()
  assert.equal(view.text, 'before\r\n')

  await world.drop()
  assert.deepEqual([list.get(watched).state, list.get(unwatched).state], ['away', 'away'])
  // 断着的时候写不进去，说清楚是没连上
  const failure = await failureOf(
    world.command('terminal.write', { terminalId: watched, data: btoa('x') }),
  )
  assert.equal(failure.code, 'offline')
  // 断线期间进程照跑
  world.procs.emit(watched, 'while away\r\n')
  world.procs.emit(unwatched, 'still nobody\r\n')

  await world.back()
  assert.deepEqual([list.get(watched).state, list.get(unwatched).state], ['running', 'running'])
  // 只挂回了看着的那个，从手里已有的偏移起
  assert.deepEqual(world.sent('litch/process/attach'), [{ processHandle: watched, fromOffset: 8 }])
  assert.equal(view.text, 'before\r\nwhile away\r\n')
  assert.deepEqual(view.marks, [{ kind: 'rejoined', missed: 0, replayed: 12 }])
  assert.equal(view.state.snapshots, 1, '订阅没有重来，内容是接着补的')

  // 之后的输出照常
  world.procs.emit(watched, 'after\r\n')
  await world.idle()
  world.time.advance(8)
  assert.equal(view.text, 'before\r\nwhile away\r\nafter\r\n')
})

test('断线期间的输出超过了设备留着的量：缺了多少说得出来', async () => {
  const world = terminalWorld({ keep: 16 })
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id)
  world.procs.emit(id, '0123456789')
  await world.idle()
  await world.drop()
  world.procs.emit(id, 'abcdefghijklmnopqrstuvwxyz')
  await world.back()
  // 设备只留了末尾 16 个字节：从 10 到 20 的那一段没有了
  assert.deepEqual(view.marks, [{ kind: 'rejoined', missed: 10, replayed: 16 }])
  assert.equal(view.text, '0123456789klmnopqrstuvwxyz')
  assert.equal(view.state.offset, 36)
})

test('断线期间进程自己退出了：连回来标成已退出，带着退出码，末尾的输出还取得到', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const id = await world.open()
  const view = watchTerminal(world.core, id)
  await world.drop()
  world.procs.emit(id, 'bye\r\n')
  world.procs.exit(id, 3)
  await world.back()
  assert.deepEqual([list.get(id).state, list.get(id).exitCode], ['exited', 3])
  assert.equal(view.text, 'bye\r\n')
  // 退出的不算活着的
  assert.deepEqual(world.core.terminalsAlive(), { durable: 0, ephemeral: 0 })
})

test('设备服务重启过：终端标成没了，在同一个标签里重开，内容清掉从头来', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const id = await world.open()
  const view = watchTerminal(world.core, id)
  world.procs.emit(id, 'old\r\n')
  await world.idle()
  await world.command('terminal.rename', { terminalId: id, title: '构建' })

  await world.drop()
  world.procs.restarted()
  await world.back()
  assert.equal(list.get(id).state, 'lost')
  // 还在跑的不能重开
  const other = await world.open()
  assert.equal(
    (await failureOf(world.command('terminal.restart', { terminalId: other, rows: 24, cols: 80 })))
      .code,
    'rejected',
  )

  await world.command('terminal.restart', { terminalId: id, rows: 30, cols: 90 })
  await world.idle()
  const spawn = world.sent('process/spawn').at(-1) as { processHandle: string; size: unknown }
  assert.notEqual(spawn.processHandle, id, '换了一个句柄')
  assert.deepEqual(spawn.size, { rows: 30, cols: 90 })
  const entry = list.get(id)
  assert.deepEqual([entry.state, entry.title, entry.rows, entry.cols], ['running', '构建', 30, 90])
  world.procs.emit(spawn.processHandle, 'new\r\n')
  await world.idle()
  assert.equal(view.text, 'new\r\n')
  assert.deepEqual([view.state.resets, view.state.epoch, view.state.offset], [1, 1, 5])
})

test('应用重开：设备上活着的终端按标记恢复成标签，名字、顺序、归属都在；看哪个才取哪个', async () => {
  const world = terminalWorld({ keep: 32 })
  await world.start()
  const first = await world.open('w1')
  const second = await world.open(null)
  const third = await world.open('w1')
  await world.command('terminal.rename', { terminalId: third, title: '日志' })
  world.procs.emit(first, 'x'.repeat(40))
  world.procs.emit(first, 'tail of the first terminal\r\n')
  world.procs.emit(second, 'second\r\n')
  await world.idle()

  await world.relaunch()
  const list = watchTerminals(world.core)
  assert.deepEqual(
    list.shown().map((entry) => [entry.id, entry.workspaceId, entry.seq, entry.title, entry.state]),
    [
      [first, 'w1', 1, null, 'running'],
      [second, null, 1, null, 'running'],
      [third, 'w1', 2, '日志', 'running'],
    ],
  )
  assert.ok(list.shown().every((entry) => entry.durable))
  assert.equal(world.sent('litch/process/attach').length, 0, '没人看的时候一个都不取')

  // 点开第一个：从设备留着的最早那个字节起，更早的本来就没见过，不算缺
  const view = watchTerminal(world.core, first)
  assert.equal(view.view, null, '还不知道从哪个偏移开始，先不给快照')
  await world.idle()
  assert.deepEqual(world.sent('litch/process/attach'), [{ processHandle: first }])
  assert.deepEqual(view.view, { viewer: 1, epoch: 0, from: 36, missed: 0, truncated: true })
  assert.equal(view.text, 'xxxxtail of the first terminal\r\n')
  assert.deepEqual(view.marks, [])
  // 接回来的终端照常能写
  await world.command('terminal.write', { terminalId: first, data: btoa('ls\r') })
  await world.idle()
  assert.deepEqual(world.procs.writes.at(-1), { handle: first, text: 'ls\r' })
  // 新开的排在后面，序号不和恢复的撞
  const fourth = await world.open('w1')
  assert.deepEqual([list.get(fourth).seq, list.shown().at(-1)?.id], [3, fourth])
})

test('列表跟着设备上的增减变：别处开的出现，别处清掉的消失，不是终端的不收', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const mine = await world.open()
  const tag = {
    litch: 'terminal',
    v: 1,
    workspace: 'gone',
    root: '/work/app/',
    title: '别的电脑开的',
    seq: 4,
    order: 5,
    cwd: null,
  }
  world.procs.startElsewhere('elsewhere-1', tag)
  // 别的客户端拿这个扩展干别的：不是我们的标记
  world.procs.startElsewhere('elsewhere-2', { owner: 'someone-else' })
  world.procs.startElsewhere('elsewhere-3', null)
  await world.idle()
  assert.deepEqual([...list.state.terminals.keys()].sort(), ['elsewhere-1', mine].sort())
  const adopted = list.get('elsewhere-1')
  // 标记里的工作区对不上了，按根目录找到现在的工作区
  assert.deepEqual(
    [adopted.workspaceId, adopted.title, adopted.seq, adopted.shown, adopted.rows, adopted.cols],
    ['w1', '别的电脑开的', 4, true, 30, 100],
  )
  // 它排在自己开的前面（顺序是标记里记的）
  assert.deepEqual(
    list.shown().map((entry) => entry.id),
    ['elsewhere-1', mine],
  )

  world.procs.removeElsewhere('elsewhere-1')
  world.procs.removeElsewhere('elsewhere-2')
  await world.idle()
  assert.deepEqual([...list.state.terminals.keys()], [mine])
})

test('关标签的两种意思：留在设备上的进程还在、能接回；结束的在设备上真的没了', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const kept = await world.open()
  const ended = await world.open()
  const view = watchTerminal(world.core, kept)
  world.procs.emit(kept, 'building...\r\n')
  await world.idle()

  await world.command('terminal.close', { terminalId: kept, mode: 'leave' })
  await world.idle()
  assert.equal(list.get(kept).shown, false)
  assert.equal(list.get(kept).state, 'running')
  assert.equal(world.procs.info(kept).running, true)
  assert.equal(world.procs.info(kept).attached, 0, '不看了就不让设备往这边发它的输出')
  assert.deepEqual(world.saved.at(-1)?.hidden, [kept])
  assert.equal(world.sent('litch/process/kill').length, 0)
  // 留在设备上的不算“退出时要问的”
  assert.deepEqual(world.core.terminalsAlive(), { durable: 1, ephemeral: 0 })
  view.close()

  await world.command('terminal.close', { terminalId: ended, mode: 'end' })
  await world.idle()
  assert.deepEqual(world.sent('litch/process/kill'), [{ processHandle: ended, remove: true }])
  assert.equal(world.procs.procs.has(ended), false)
  assert.equal(list.state.terminals.has(ended), false)

  // 应用重开：留着的那个还是不在标签里，但列得出来、接得回
  world.procs.emit(kept, 'done\r\n')
  await world.relaunch()
  const again = watchTerminals(world.core)
  assert.deepEqual(
    [...again.state.terminals.values()].map((entry) => [entry.id, entry.shown, entry.state]),
    [[kept, false, 'running']],
  )
  await world.command('terminal.show', { terminalId: kept })
  assert.equal(again.get(kept).shown, true)
  assert.deepEqual(world.saved.at(-1)?.hidden, [])
  const back = watchTerminal(world.core, kept)
  await world.idle()
  assert.equal(back.text, 'building...\r\ndone\r\n')
})

test('设备没连着的时候结束不了：不关标签，说明原因；不属于设备的进程留不住', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const id = await world.open()
  await world.disconnect()
  assert.equal(list.get(id).state, 'away')
  const failure = await failureOf(world.command('terminal.close', { terminalId: id, mode: 'end' }))
  assert.equal(failure.code, 'offline')
  assert.deepEqual(failure.text, { key: 'terminal.endOffline' })
  assert.equal(list.state.terminals.has(id), true)
  assert.equal(world.procs.info(id).running, true)
  // 留着是可以的：它本来就在设备上
  await world.command('terminal.close', { terminalId: id, mode: 'leave' })
  assert.equal(list.get(id).shown, false)
})

test('退出应用前的清点和“都结束”：只算开成标签、还在跑的；选了结束的在设备上真的没了', async () => {
  const world = terminalWorld()
  await world.start()
  const one = await world.open()
  const two = await world.open()
  const stowed = await world.open()
  const dead = await world.open()
  await world.command('terminal.close', { terminalId: stowed, mode: 'leave' })
  world.procs.exit(dead, 0)
  await world.idle()
  assert.deepEqual(world.core.terminalsAlive(), { durable: 2, ephemeral: 0 })

  await world.core.endTerminals()
  await world.idle()
  assert.equal(world.procs.procs.has(one), false)
  assert.equal(world.procs.procs.has(two), false)
  assert.equal(world.procs.info(stowed).running, true, '说了留着的不动')
  assert.deepEqual(world.core.terminalsAlive(), { durable: 0, ephemeral: 0 })
})
