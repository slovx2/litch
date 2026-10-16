// 终端会话（packages/core/src/device/terminals.mts），属于设备的那一种：开、输出按偏移、输入、行列数，
// 以及大量输出时的解除挂接再挂回。对着假的聚合面和假进程（terminal-world.mts）。
// 断线、应用重开、关标签的两种意思在 terminals-rejoin.test.mts。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type ChannelError, LAUNCH_SCRIPT, PARK_BYTES } from '../src/index.mjs'
import {
  type TerminalWorld,
  terminalWorld,
  watchTerminal,
  watchTerminals,
} from './terminal-world.mjs'

const KB = 1024

/** 一块认得出是第几块的输出，正好 size 字节 */
const block = (index: number, size: number): string =>
  `${String(index).padStart(5, '0')}|`.repeat(Math.ceil(size / 6)).slice(0, size)

/** 一块一块地出，每块之间过一拍：核心那边合并输出的定时器到点 */
async function pour(world: TerminalWorld, id: string, from: number, count: number, size: number) {
  let all = ''
  for (let at = from; at < from + count; at++) {
    const text = block(at, size)
    all += text
    world.procs.emit(id, text)
    await world.idle(1)
    world.time.advance(8)
  }
  await world.idle()
  return all
}

/** 界面开始处理并回报，直到把核心手里的都拿完 */
async function drain(world: TerminalWorld, view: ReturnType<typeof watchTerminal>) {
  view.state.autoAck = true
  view.frame()
  view.ack()
  let before = -1
  for (let round = 0; round < 200 && before !== view.received; round++) {
    before = view.received
    for (let step = 0; step < 4; step++) {
      await world.idle(2)
      world.time.advance(8)
      view.frame()
    }
  }
}

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('握手时声明了可重连的终端；设备声明了它，列表就标成属于设备', async () => {
  const world = terminalWorld()
  await world.start()
  const init = world.peer.last().seen.find((entry) => entry.method === 'initialize')?.params as {
    capabilities: { litchExtensions: string[] }
  }
  assert.ok(init.capabilities.litchExtensions.includes('deviceProcesses'))
  assert.equal(watchTerminals(world.core).state.durable, true)
  assert.equal(world.sent('litch/process/list').length, 1)
})

test('开终端：命令行、伪终端、环境、不限时不限量，标记里带着工作区、序号和顺序', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const first = await world.open('w1')
  const second = await world.open('w1', '/work/app/src')
  const loose = await world.open(null)

  const spawns = world.sent('process/spawn')
  assert.equal(spawns.length, 3)
  const [spawn, deeper, home] = spawns as {
    command: string[]
    processHandle: string
    litchDevice: { tag: Record<string, unknown> }
  }[]
  // 目录走位置参数，不拼进脚本；请求的目录排在工作区的根前面
  assert.deepEqual(spawn?.command, ['/bin/sh', '-c', LAUNCH_SCRIPT, 'litch-terminal', '/work/app'])
  assert.deepEqual(deeper?.command.slice(4), ['/work/app/src', '/work/app'])
  assert.deepEqual(home?.command.slice(4), [])
  assert.deepEqual(
    { ...spawns[0], command: null, processHandle: null, litchDevice: null },
    {
      command: null,
      processHandle: null,
      litchDevice: null,
      cwd: '/home/dev',
      tty: true,
      size: { rows: 24, cols: 80 },
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Litch' },
      timeoutMs: null,
      outputBytesCap: null,
    },
  )
  assert.equal(spawn?.processHandle, first)
  const tag = spawn?.litchDevice.tag
  assert.equal(typeof tag?.order, 'number')
  assert.deepEqual(
    { ...tag, order: 0 },
    {
      litch: 'terminal',
      v: 1,
      workspace: 'w1',
      root: '/work/app',
      title: null,
      seq: 1,
      order: 0,
      cwd: null,
    },
  )
  assert.equal(deeper?.litchDevice.tag.seq, 2)
  assert.deepEqual(
    [home?.litchDevice.tag.workspace, home?.litchDevice.tag.root, home?.litchDevice.tag.seq],
    [null, null, 1],
  )

  assert.deepEqual(
    list.shown().map((entry) => [entry.id, entry.workspaceId, entry.seq, entry.state, entry.cwd]),
    [
      [first, 'w1', 1, 'running', '/work/app'],
      [second, 'w1', 2, 'running', '/work/app/src'],
      [loose, null, 1, 'running', '/home/dev'],
    ],
  )
  assert.ok(list.shown().every((entry) => entry.durable && entry.title === null))
})

test('输出：按偏移接着来，连着到的合成一条，中文拆在两块里也不坏', async () => {
  const world = terminalWorld()
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id)
  assert.deepEqual(view.view, { viewer: 1, epoch: 0, from: 0, missed: 0, truncated: false })

  world.procs.emit(id, 'hello ')
  await world.idle()
  assert.equal(view.text, 'hello ')
  // 歇过之后的第一块不等；紧跟着的几块攒到一起
  world.time.advance(50)
  world.procs.emit(id, '世')
  world.procs.emit(id, '界')
  world.procs.emit(id, '\r\n$ ')
  await world.idle()
  world.time.advance(8)
  assert.equal(view.text, 'hello 世界\r\n$ ')
  assert.deepEqual(view.state.ranges, [
    [0, 6],
    [6, 9],
    [9, 16],
  ])
  assert.deepEqual(view.marks, [])
})

test('起的过程中改了行列数：起来之后补发，对面的伪终端跟上界面要的大小', async () => {
  let release = () => {}
  const gate = new Promise<void>((done) => {
    release = done
  })
  const world: TerminalWorld = terminalWorld({
    extra: {
      // 起进程的应答晚一点到：界面量准字宽之后的那一次改大小，就落在“正在启动”里
      'process/spawn': (params) => gate.then(() => world.procs.handlers['process/spawn']?.(params)),
    },
  })
  await world.start()
  const list = watchTerminals(world.core)
  const opening = world.command('terminal.open', { workspaceId: 'w1', rows: 13, cols: 100 })
  await world.idle()
  const [starting] = list.shown()
  assert.equal(starting?.state, 'starting')
  const id = starting?.id ?? ''

  // 这时候发不了：进程还没起来
  await world.command('terminal.resize', { terminalId: id, rows: 11, cols: 96 })
  await world.idle()
  assert.deepEqual(world.sent('process/resizePty'), [])

  release()
  await opening
  await world.idle(6)
  assert.equal(list.get(id).state, 'running')
  // 进程是按起的那一刻要的大小起的，随后补上界面后来要的
  assert.deepEqual(world.sent('process/spawn')[0]?.size, { rows: 13, cols: 100 })
  assert.deepEqual(
    world.sent('process/resizePty').map((entry) => entry.size),
    [{ rows: 11, cols: 96 }],
  )
  assert.deepEqual(world.procs.info(id).size, { rows: 11, cols: 96 })
  assert.deepEqual([list.get(id).rows, list.get(id).cols], [11, 96])
})

test('输入、行列数、重画：都落到对面的进程上，行列数以对面收下的为准', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  const id = await world.open()

  await world.command('terminal.write', { terminalId: id, data: btoa('ls\r') })
  await world.command('terminal.write', { terminalId: id, data: btoa('pwd\r') })
  await world.idle()
  assert.deepEqual(world.procs.writes, [
    { handle: id, text: 'ls\r' },
    { handle: id, text: 'pwd\r' },
  ])

  // 连着改两次：同时只发一个，发完再发最后要的那个
  await world.command('terminal.resize', { terminalId: id, rows: 30, cols: 100 })
  await world.command('terminal.resize', { terminalId: id, rows: 40, cols: 120 })
  await world.idle(6)
  assert.deepEqual(
    world.sent('process/resizePty').map((entry) => entry.size),
    [
      { rows: 30, cols: 100 },
      { rows: 40, cols: 120 },
    ],
  )
  assert.deepEqual([list.get(id).rows, list.get(id).cols], [40, 120])
  assert.deepEqual(world.procs.info(id).size, { rows: 40, cols: 120 })

  // 重画：行列数没变程序收不到信号，所以先差一行再改回来
  await world.command('terminal.redraw', { terminalId: id })
  await world.idle(6)
  assert.deepEqual(
    world
      .sent('process/resizePty')
      .slice(2)
      .map((entry) => entry.size),
    [
      { rows: 39, cols: 120 },
      { rows: 40, cols: 120 },
    ],
  )
})

test('到了设备的上限：说清楚是到上限了，不留下一个空标签', async () => {
  const world = terminalWorld()
  await world.start()
  const list = watchTerminals(world.core)
  world.procs.limit = 1
  await world.open()
  const failure = await failureOf(
    world.command('terminal.open', { workspaceId: 'w1', rows: 24, cols: 80 }),
  )
  assert.equal(failure.code, 'rejected')
  assert.deepEqual(failure.text, { key: 'terminal.limit', args: { limit: 1 } })
  assert.equal(list.state.terminals.size, 1)
})

test('积压过了线：先解除挂接，界面追上之后按偏移挂回，设备把留着的补齐，一个字节不少', async () => {
  const world = terminalWorld({ keep: 8 * KB * KB })
  await world.start()
  const id = await world.open()
  // 界面一点都不处理
  const view = watchTerminal(world.core, id, { autoAck: false })

  let all = await pour(world, id, 0, 16, 64 * KB)
  assert.equal(world.sent('litch/process/detach').length, 1, '积压过线之后解除了挂接')
  assert.equal(world.procs.info(id).attached, 0)
  // 交给界面的只到它压得住的量为止
  assert.ok(view.received < 400 * KB, `界面手上压着 ${view.received} 字节`)
  const parkedAt = world.procs.info(id).retained.to

  // 解除期间进程照跑：这些只进设备的缓冲，不往这条连接上发
  all += await pour(world, id, 16, 8, 64 * KB)
  assert.equal(world.sent('litch/process/attach').length, 0, '界面没追上之前不挂回')

  await drain(world, view)
  const attaches = world.sent('litch/process/attach')
  assert.ok(attaches.length >= 1)
  assert.ok((attaches[0]?.fromOffset as number) <= parkedAt)
  assert.ok((attaches[0]?.fromOffset as number) >= PARK_BYTES)
  assert.equal(view.text, all)
  assert.deepEqual(view.marks, [])
  // 增量首尾相接，没有重的也没有漏的
  let at = 0
  for (const [from, to] of view.state.ranges) {
    assert.equal(from, at)
    at = to
  }
  assert.equal(at, all.length)
})

test('输出一口气涌来，比核心留得住的还多：当场解除，之后按偏移补齐，一个字节不少', async () => {
  const world = terminalWorld({ keep: 8 * KB * KB })
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id, { autoAck: false })

  // 三兆，中间一拍都不歇：合并输出的定时器来不及到点，对面也来不及应答“解除”
  let all = ''
  for (let at = 0; at < 48; at++) {
    const text = block(at, 64 * KB)
    all += text
    world.procs.emit(id, text)
  }
  await world.idle()
  assert.equal(world.sent('litch/process/detach').length, 1, '积压一过线就解除，只解除一次')

  await drain(world, view)
  assert.equal(view.text.length, all.length)
  assert.equal(view.text, all)
  assert.deepEqual(view.marks, [], '设备上都留着，不该有“少了一段”')
})

test('正在解除的时候进程退出了：没收下的那一截等挂回去补，不算丢', async () => {
  const world = terminalWorld({ keep: 8 * KB * KB })
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id, { autoAck: false })
  const tabs = watchTerminals(world.core)

  let all = ''
  for (let at = 0; at < 24; at++) {
    const text = block(at, 64 * KB)
    all += text
    world.procs.emit(id, text)
  }
  world.procs.exit(id, 0)
  await world.idle()
  assert.equal(tabs.get(id).state, 'exited')

  await drain(world, view)
  assert.equal(view.text, all)
  assert.deepEqual(view.marks, [])
})

test('挂回时设备留着的不够：缺的那一段有记号，之后的内容接得上', async () => {
  const world = terminalWorld({ keep: 100 * KB })
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id, { autoAck: false })

  const head = await pour(world, id, 0, 16, 64 * KB)
  assert.equal(world.sent('litch/process/detach').length, 1)
  const tail = await pour(world, id, 16, 8, 64 * KB)
  const total = head.length + tail.length

  await drain(world, view)
  const from = world.sent('litch/process/attach')[0]?.fromOffset as number
  const missed = total - 100 * KB - from
  assert.ok(missed > 0)
  assert.deepEqual(view.marks, [{ kind: 'backlog', missed }])
  assert.equal(view.state.marks[0]?.at, from)
  // 记号前面是解除之前收到的，后面是设备留着的末尾
  assert.equal(view.text, (head + tail).slice(0, from) + (head + tail).slice(total - 100 * KB))
  assert.equal(view.state.offset, total)
})

test('解除期间敲了键：先挂回去再按先后写，写完一小会儿之内不再解除', async () => {
  const world = terminalWorld({ keep: 8 * KB * KB })
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id, { autoAck: false })
  await pour(world, id, 0, 16, 64 * KB)
  assert.equal(world.sent('litch/process/detach').length, 1)

  // 中断键和后面的输入都不能丢，也不能乱
  await world.command('terminal.write', { terminalId: id, data: btoa('\u0003') })
  await world.command('terminal.write', { terminalId: id, data: btoa('q') })
  assert.equal(world.procs.writes.length, 0, '没挂着的时候写了也落不到进程上，先攒着')
  await world.idle(6)
  assert.equal(world.sent('litch/process/attach').length, 1)
  assert.deepEqual(
    world.procs.writes.map((entry) => entry.text),
    ['\u0003', 'q'],
  )
  assert.equal(view.received > 0, true)

  // 界面还是没处理、积压还在线以上，但刚写过输入：不解除
  await pour(world, id, 16, 2, 64 * KB)
  assert.equal(world.sent('litch/process/detach').length, 1)
  // 过了那一小会儿，照旧
  world.time.advance(1000)
  await pour(world, id, 18, 1, 64 * KB)
  assert.equal(world.sent('litch/process/detach').length, 2)
})
