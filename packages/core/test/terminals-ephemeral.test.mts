// 终端会话，随连接结束的那一种：对面没有可重连的终端（没声明这项扩展的设备服务、某个 harness 自己的入口）。
// 用的是协议原有的 process/*，断线进程就没了：标签和内容留着，标成没了，可以在同一个标签里重开。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChannelError } from '../src/index.mjs'
import { fakeProcesses } from './fake-processes.mjs'
import { settle } from './helpers.mjs'
import {
  type TerminalWorld,
  terminalWorld,
  watchTerminal,
  watchTerminals,
} from './terminal-world.mjs'
import { setup as single } from './world.mjs'

const never = { aborted: false, addEventListener() {} }
const KB = 1024

async function failureOf(run: Promise<unknown>): Promise<ChannelError> {
  try {
    await run
  } catch (error) {
    return error as ChannelError
  }
  throw new Error('这条命令本该失败')
}

test('设备没声明可重连的终端：连扩展参数都不带，进程属于这条连接，偏移自己数', async () => {
  const world = terminalWorld({ extensions: ['harness'] })
  await world.start()
  const list = watchTerminals(world.core)
  assert.equal(list.state.durable, false)
  assert.equal(world.sent('litch/process/list').length, 0, '没声明就不去列')
  const id = await world.open()
  assert.equal('litchDevice' in (world.sent('process/spawn')[0] ?? {}), false)
  assert.equal(list.get(id).durable, false)
  assert.deepEqual(world.core.terminalsAlive(), { durable: 0, ephemeral: 1 })

  const view = watchTerminal(world.core, id)
  world.procs.emit(id, 'one ')
  await world.idle()
  world.time.advance(8)
  world.procs.emit(id, 'two\r\n')
  await world.idle()
  assert.equal(view.text, 'one two\r\n')
  assert.deepEqual(view.state.ranges, [
    [0, 4],
    [4, 9],
  ])

  // 留不住：它不属于设备
  const failure = await failureOf(
    world.command('terminal.close', { terminalId: id, mode: 'leave' }),
  )
  assert.equal(failure.code, 'rejected')
  assert.equal(list.get(id).shown, true)

  // 结束用的是协议原有的那一个
  await world.command('terminal.close', { terminalId: id, mode: 'end' })
  await world.idle()
  assert.deepEqual(world.sent('process/kill'), [{ processHandle: id }])
  assert.equal(world.sent('litch/process/kill').length, 0)
  assert.equal(list.state.terminals.size, 0)
})

test('断线：标签和内容留着，标成没了，连回来也不会自己好；在同一个标签里重开', async () => {
  const world = terminalWorld({ extensions: ['harness'] })
  await world.start()
  const list = watchTerminals(world.core)
  const id = await world.open()
  const view = watchTerminal(world.core, id)
  world.procs.emit(id, 'before\r\n')
  await world.idle()
  assert.equal(view.text, 'before\r\n')

  await world.drop()
  assert.equal(list.get(id).state, 'lost')
  assert.equal(view.text, 'before\r\n', '内容还在')
  assert.deepEqual(world.core.terminalsAlive(), { durable: 0, ephemeral: 0 })
  await world.back()
  assert.equal(list.get(id).state, 'lost')
  assert.equal(world.sent('litch/process/attach').length, 0)
  // 没了的写不进去
  const failure = await failureOf(
    world.command('terminal.write', { terminalId: id, data: btoa('x') }),
  )
  assert.deepEqual([failure.code, failure.text], ['rejected', { key: 'terminal.notRunning' }])

  await world.command('terminal.restart', { terminalId: id, rows: 24, cols: 80 })
  await world.idle()
  const handle = (world.sent('process/spawn').at(-1) as { processHandle: string }).processHandle
  assert.notEqual(handle, id)
  assert.equal(list.get(id).state, 'running')
  world.procs.emit(handle, 'again\r\n')
  await world.idle()
  assert.equal(view.text, 'again\r\n')
  assert.deepEqual([view.state.resets, view.state.epoch], [1, 1])
  await world.command('terminal.write', { terminalId: id, data: btoa('ls\r') })
  await world.idle()
  assert.deepEqual(world.procs.writes, [{ handle, text: 'ls\r' }])
})

test('进程自己退出：标成已退出、带着退出码；关掉已退出的不用再去结束', async () => {
  const world = terminalWorld({ extensions: ['harness'] })
  await world.start()
  const list = watchTerminals(world.core)
  const id = await world.open()
  world.procs.exit(id, 2)
  await world.idle()
  assert.deepEqual([list.get(id).state, list.get(id).exitCode], ['exited', 2])
  await world.command('terminal.close', { terminalId: id, mode: 'end' })
  assert.equal(world.sent('process/kill').length, 0)
  assert.equal(list.state.terminals.size, 0)
})

test('大量输出而界面不处理：没有挂接可解除，核心照收但只留末尾，少的那段有记号', async () => {
  const world = terminalWorld({ extensions: ['harness'] })
  await world.start()
  const id = await world.open()
  const view = watchTerminal(world.core, id, { autoAck: false })
  const size = 64 * KB
  const count = 40
  let last = ''
  for (let at = 0; at < count; at++) {
    last = String(at % 10).repeat(size)
    world.procs.emit(id, last)
    await world.idle(1)
    world.time.advance(8)
  }
  await world.idle()
  assert.equal(world.sent('litch/process/detach').length, 0)
  const held = view.received
  assert.ok(held < 400 * KB, `界面手上只压着 ${held} 字节`)

  // 界面开始处理：先拿到的是当时压着的，然后跳过中间，接上末尾
  view.state.autoAck = true
  view.ack()
  for (let round = 0; round < 60; round++) {
    await world.idle(1)
    world.time.advance(8)
    view.frame()
  }
  const total = size * count
  assert.equal(view.state.offset, total)
  assert.equal(view.marks.length, 1)
  const [mark] = view.state.marks
  assert.equal(mark?.at, held)
  assert.equal(mark?.mark.kind, 'backlog')
  // 留着的末尾是 1 MiB 上下（按整块丢）
  const tail = view.received - held
  assert.ok(tail > 900 * KB && tail <= 1024 * KB + size, `末尾留了 ${tail} 字节`)
  assert.equal(held + (mark?.mark.missed ?? 0) + tail, total)
  assert.ok(view.text.endsWith(last))
})

test('某个 harness 自己的入口：没有主目录可报，目录全在对面定；终端随连接结束', async () => {
  const procs = fakeProcesses(() => world.peer.last())
  const world = single(undefined, procs.handlers)
  world.core.start()
  await settle()
  await settle()
  const list = watchTerminals(world.core)
  assert.equal(list.state.durable, false)
  const { terminalId } = (await world.core.command(
    'terminal.open',
    { deviceId: 'local', workspaceId: null, rows: 30, cols: 100 },
    never,
  )) as { terminalId: string }
  const spawn = world.sent('process/spawn')[0] as Record<string, unknown>
  assert.equal(spawn.cwd, '/')
  assert.deepEqual(spawn.size, { rows: 30, cols: 100 })
  assert.equal('litchDevice' in spawn, false)
  const entry = list.get(terminalId)
  assert.deepEqual([entry.durable, entry.state, entry.cwd], [false, 'running', null])
})

test('对面不会起进程：说清楚是不支持，不留下一个空标签', async () => {
  const world = single()
  world.core.start()
  await settle()
  await settle()
  const list = watchTerminals(world.core)
  const failure = await failureOf(
    world.core.command(
      'terminal.open',
      { deviceId: 'local', workspaceId: null, rows: 24, cols: 80 },
      never,
    ),
  )
  assert.equal(failure.code, 'unsupported')
  assert.deepEqual(failure.text, { key: 'terminal.unsupported' })
  assert.equal(list.state.terminals.size, 0)
})

test('Windows 设备：这一版开不了，直接说明，不发请求', async () => {
  const world: TerminalWorld = terminalWorld({
    extra: {
      'runtime/info': (params) => {
        const info = world.fake.handlers['runtime/info']?.(params) as {
          device: Record<string, unknown>
        }
        return { ...info, device: { ...info.device, os: 'windows' } }
      },
    },
  })
  await world.start()
  const failure = await failureOf(
    world.command('terminal.open', { workspaceId: null, rows: 24, cols: 80 }),
  )
  assert.equal(failure.code, 'unsupported')
  assert.deepEqual(failure.text, { key: 'terminal.windows' })
  assert.equal(world.sent('process/spawn').length, 0)
})

test('没连上的时候开不了；不认识的终端按“没有这个”报', async () => {
  const world = terminalWorld()
  await world.start()
  const missing = await failureOf(
    world.command('terminal.write', { terminalId: 'nope', data: btoa('x') }),
  )
  assert.equal(missing.code, 'notFound')
  await world.disconnect()
  const failure = await failureOf(
    world.command('terminal.open', { workspaceId: null, rows: 24, cols: 80 }),
  )
  assert.equal(failure.code, 'offline')
})
