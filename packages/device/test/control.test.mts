// 控制通道在设备进程这一头：对着一个扮演适配器主进程的本机套接字，
// 看状态的接收、请求和应答的配对、错误的转述、超时，以及断线之后的重连。
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { ControlFailure, type ControlState, SocketControl } from '../src/control.mjs'
import { settle, tempDir } from './helpers.mjs'

const SNAPSHOT = { version: 3, values: {}, explicit: [], pendingRestart: [], sshEntries: [] }

const state = (keys: string[] = [], version = 3): ControlState => ({
  keys,
  harnesses: [{ id: 'pi', socket: 'unix:///nowhere/runtime.sock', state: 'running', text: null }],
  snapshot: { ...SNAPSHOT, version },
})

/** 扮演主进程的那一头：连上就给一份状态，请求按 answer 应答（返回 undefined 表示不答） */
class FakeService {
  readonly path: string
  readonly received: { id: number; method: string; params: any }[] = []
  readonly sockets = new Set<net.Socket>()
  answer: (request: { id: number; method: string; params: any }) => unknown = (request) => ({
    id: request.id,
    result: { echoed: request.method },
  })
  greeting: ControlState | null = state()
  private server: net.Server | null = null

  constructor(directory: string) {
    this.path = join(directory, 'ctl.sock')
  }

  listen(): Promise<void> {
    const server = net.createServer((socket) => {
      this.sockets.add(socket)
      socket.setEncoding('utf8')
      socket.on('error', () => {})
      socket.once('close', () => this.sockets.delete(socket))
      if (this.greeting) this.push(this.greeting, socket)
      let buffer = ''
      socket.on('data', (chunk: string) => {
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const request = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          this.received.push(request)
          const reply = this.answer(request)
          if (reply !== undefined) socket.write(`${JSON.stringify(reply)}\n`)
        }
      })
    })
    this.server = server
    return new Promise((resolve) => server.listen(this.path, resolve))
  }

  push(next: ControlState, only?: net.Socket): void {
    const line = `${JSON.stringify({ method: 'state', params: next })}\n`
    for (const socket of only ? [only] : this.sockets) socket.write(line)
  }

  /** 主进程没了：监听和现有的连接一起关掉 */
  stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    const server = this.server
    this.server = null
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }
}

/** 通道上最近一次收到的状态。经函数取，免得前面断言过的值被当成一直不变 */
const latest = (control: SocketControl): ControlState | null => control.state

async function until(done: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`等了 ${timeoutMs} 毫秒没有等到：${what}`)
    await settle(10)
  }
}

async function rejection(promise: Promise<unknown>): Promise<ControlFailure> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ControlFailure, `应该是控制通道的错误，却是 ${String(error)}`)
    return error
  }
  throw new Error('应该失败，却成功了')
}

test('连上就收到状态；请求和应答配对；主进程给的错误原样带回', async () => {
  const directory = tempDir()
  const service = new FakeService(directory)
  await service.listen()
  const logs: string[] = []
  const control = new SocketControl(service.path, (line) => logs.push(line), 30)
  try {
    assert.equal(latest(control), null)
    const seen: ControlState[] = []
    control.onState = (next) => seen.push(next)
    control.start()
    assert.equal(await control.ready(2000), true)
    assert.equal(latest(control)?.snapshot.version, 3)
    assert.equal(seen.length, 1)

    // 两个请求的应答倒着回来，各归各的
    const held: { id: number }[] = []
    service.answer = (request) => {
      held.push(request)
      return undefined
    }
    const first = control.request('settings.read', {}, 2000)
    const second = control.request('ssh.config', {}, 2000)
    await until(() => held.length === 2, '两个请求都到了')
    for (const socket of service.sockets) {
      socket.write(`${JSON.stringify({ id: held[1]?.id, result: 'second' })}\n`)
      socket.write(`${JSON.stringify({ id: held[0]?.id, result: 'first' })}\n`)
    }
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second'])

    service.answer = (request) => ({
      id: request.id,
      error: {
        reason: 'conflict',
        text: { 'zh-CN': '版本号对不上', en: 'Version mismatch' },
        snapshot: SNAPSHOT,
      },
    })
    const conflict = await rejection(control.request('settings.write', { edits: [] }, 2000))
    assert.equal(conflict.detail.reason, 'conflict')
    assert.equal(conflict.message, '版本号对不上')
    assert.equal(conflict.detail.snapshot?.version, 3)

    // 之后推来的状态照样收到
    service.push(state(['harness.pi.enabled'], 4))
    await until(() => seen.length === 2, '第二条状态')
    assert.deepEqual(latest(control)?.keys, ['harness.pi.enabled'])
    assert.equal(latest(control)?.snapshot.version, 4)
  } finally {
    control.close()
    await service.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('主进程不答：到点落空并说明；请求的内容不进日志', async () => {
  const directory = tempDir()
  const service = new FakeService(directory)
  service.answer = () => undefined
  await service.listen()
  const logs: string[] = []
  const control = new SocketControl(service.path, (line) => logs.push(line), 30)
  try {
    control.start()
    await control.ready(2000)
    const edits = [{ key: 'harness.pi.env', value: [{ name: 'API_KEY', value: 'TOP-SECRET' }] }]
    const timedOut = await rejection(control.request('settings.write', { edits }, 60))
    assert.equal(timedOut.detail.reason, 'unavailable')
    assert.ok(timedOut.detail.text.en)
    await until(() => service.received.length === 1, '请求到了那一头')
    assert.ok(!logs.join('\n').includes('TOP-SECRET'), '密钥没有进日志')
    assert.ok(!logs.join('\n').includes('API_KEY'))
  } finally {
    control.close()
    await service.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('主进程不在：功能不可用并说明，不出错；它回来之后自己接上', async () => {
  const directory = tempDir()
  const service = new FakeService(directory)
  const control = new SocketControl(service.path, () => {}, 30)
  try {
    // 那一头还没有人在听
    control.start()
    assert.equal(await control.ready(100), false)
    assert.equal(latest(control), null)
    const absent = await rejection(control.request('settings.read', {}, 500))
    assert.equal(absent.detail.reason, 'unavailable')

    // 起来之后自己连上
    await service.listen()
    assert.equal(await control.ready(2000), true)
    assert.deepEqual(await control.request('settings.read', {}, 2000), {
      echoed: 'settings.read',
    })

    // 等应答的时候那一头没了：等着的请求落空；最近一次的状态还留着
    service.answer = () => undefined
    const hanging = rejection(control.request('diagnostics.run', {}, 5000))
    await until(() => service.received.length === 2, '请求到了那一头')
    await service.stop()
    assert.equal((await hanging).detail.reason, 'unavailable')
    assert.equal(latest(control)?.snapshot.version, 3)
    assert.equal(
      (await rejection(control.request('settings.read', {}, 500))).detail.reason,
      'unavailable',
    )

    // 再回来：重新收到一份完整的状态，请求又能用
    const seen: ControlState[] = []
    control.onState = (next) => seen.push(next)
    service.greeting = state([], 9)
    service.answer = (request) => ({ id: request.id, result: 'back' })
    await service.listen()
    await until(() => seen.length === 1, '重连之后的状态')
    assert.equal(latest(control)?.snapshot.version, 9)
    assert.equal(await control.request('settings.read', {}, 2000), 'back')
  } finally {
    control.close()
    await service.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('关掉之后不再重连，等着的请求落空', async () => {
  const directory = tempDir()
  const service = new FakeService(directory)
  service.answer = () => undefined
  await service.listen()
  const control = new SocketControl(service.path, () => {}, 20)
  try {
    control.start()
    await control.ready(2000)
    const hanging = rejection(control.request('settings.read', {}, 5000))
    await until(() => service.received.length === 1, '请求到了那一头')
    control.close()
    assert.equal((await hanging).detail.reason, 'unavailable')
    await until(() => service.sockets.size === 0, '连接关掉了')
    await settle(80)
    assert.equal(service.sockets.size, 0, '没有再连回来')
  } finally {
    control.close()
    await service.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('主进程来问一件事：答在同一条连接上；答不上、没有人接，都如实回给它', async () => {
  const directory = tempDir()
  const service = new FakeService(directory)
  // 这一头不发请求，收到的都是对“问”的回答
  service.answer = () => undefined
  await service.listen()
  const control = new SocketControl(service.path, () => {}, 30)
  const ask = (id: number, method: string) => {
    for (const socket of service.sockets) socket.write(`${JSON.stringify({ ask: id, method })}\n`)
  }
  const replies = () => service.received as unknown as Record<string, unknown>[]
  try {
    control.start()
    assert.equal(await control.ready(2000), true)

    // 还没有人接
    ask(1, 'activity')
    await until(() => replies().length === 1, '第一个回答')
    assert.deepEqual(replies()[0], { reply: 1, error: '没有人接' })

    const asked: string[] = []
    control.onAsk = async (method) => {
      asked.push(method)
      if (method !== 'activity') throw new Error(`不认识 ${method}`)
      await settle(20)
      return { turns: ['pi'], processes: 2, connections: 1 }
    }
    // 两个问题叠在一起：各答各的，后问的先答完也不串
    ask(2, 'activity')
    ask(3, 'nonsense')
    await until(() => replies().length === 3, '后两个回答')
    assert.deepEqual(asked, ['activity', 'nonsense'])
    assert.deepEqual(replies()[1], { reply: 3, error: '不认识 nonsense' })
    assert.deepEqual(replies()[2], {
      reply: 2,
      result: { turns: ['pi'], processes: 2, connections: 1 },
    })

    // 问和自己发的请求互不相干：带着 ask 的行不会被当成哪个请求的应答
    service.answer = (request) =>
      typeof request.id === 'number' ? { id: request.id, result: 'mine' } : undefined
    const pending = control.request('settings.read', {}, 2000)
    ask(1, 'activity')
    assert.equal(await pending, 'mine')
    await until(() => replies().filter((item) => item.reply === 1).length === 2, '又一个回答')
  } finally {
    control.close()
    await service.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
