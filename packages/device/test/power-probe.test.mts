import assert from 'node:assert/strict'
import test from 'node:test'
import { probePower } from '../src/power-probe.mjs'
import type { Connector } from '../src/wire.mjs'

function rig(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let closed = 0
  const connect: Connector = async (handlers) => ({
    send(raw) {
      const frame = JSON.parse(raw)
      calls.push({ method: frame.method, params: frame.params ?? {} })
      if (frame.id === undefined) return
      queueMicrotask(() => {
        try {
          handlers.message(
            JSON.stringify({ id: frame.id, result: answer(frame.method, frame.params) }),
          )
        } catch {
          handlers.message(
            JSON.stringify({ id: frame.id, error: { code: -32601, message: 'unsupported' } }),
          )
        }
      })
    },
    close() {
      closed++
    },
  })
  return { connect, calls, closed: () => closed }
}

const options = () => ({
  signal: new AbortController().signal,
  timeoutMs: 1000,
  version: 'test',
  mode: 'recover' as const,
})
const thread = (id: string, type: string) => ({
  id,
  status: { type },
  litchBackground: { tasks: [] },
})

test('启动恢复完整分页已加载集合，第二页活动和后台均计入，不读历史列表', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'runtime/info') return { extensions: ['backgroundTasks'] }
    if (method === 'thread/loaded/list') {
      if (!params.cursor)
        return {
          data: Array.from({ length: 100 }, (_, index) => String(index)),
          nextCursor: 'second',
        }
      assert.equal(params.cursor, 'second')
      return { data: ['busy', 'background'], nextCursor: null }
    }
    assert.equal(method, 'thread/read')
    return {
      thread:
        params.threadId === 'background'
          ? { ...thread('background', 'idle'), litchBackground: { tasks: [{ status: 'running' }] } }
          : thread(String(params.threadId), params.threadId === 'busy' ? 'active' : 'idle'),
    }
  })
  const result = await probePower(
    { id: 'codex', native: true, running: true, connect: fake.connect },
    options(),
  )
  assert.deepEqual([...result.active], ['busy'])
  assert.equal(result.background.get('background'), true)
  assert.equal(fake.closed(), 1)
  assert.equal(fake.calls.filter((call) => call.method === 'thread/loaded/list').length, 2)
  assert.equal(fake.calls.filter((call) => call.method === 'thread/read').length, 102)
  assert.equal(
    fake.calls.some((call) => call.method === 'thread/list'),
    false,
  )
})

test('原生后台接口不可用给unknown，已卸载会话不查询后台', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'thread/loaded/list') return { data: ['live', 'old'], nextCursor: null }
    if (method === 'thread/read')
      return {
        thread: {
          id: params.threadId,
          status: { type: params.threadId === 'live' ? 'active' : 'notLoaded' },
        },
      }
    throw new Error('不存在')
  })
  const result = await probePower(
    { id: 'codex', running: true, native: true, connect: fake.connect },
    options(),
  )
  assert.equal(result.background.get('live'), null)
  assert.equal(result.background.get('old'), false)
  assert.deepEqual([...result.active], ['live'])
  assert.equal(
    fake.calls.filter((call) => call.method === 'thread/backgroundTerminals/list').length,
    1,
  )
  assert.equal(fake.closed(), 1)
})

test('已加载分页重复则恢复不完整，不能把部分列表当完整', async () => {
  const fake = rig((method) => (method === 'initialize' ? {} : { data: [], nextCursor: 'same' }))
  const result = await probePower(
    { id: 'codex', native: true, running: true, connect: fake.connect },
    options(),
  )
  assert.equal(result.complete, false)
  assert.equal(fake.closed(), 1)
})

test('取消探测立即返回，迟到连接关闭且不发送任何请求', async () => {
  let finish: ((wire: { send(): void; close(): void }) => void) | undefined
  let closed = 0
  let sent = 0
  const controller = new AbortController()
  const task = probePower(
    {
      id: 'pi',
      running: true,
      connect: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    },
    { ...options(), signal: controller.signal },
  )
  controller.abort()
  await assert.rejects(task, /取消/)
  assert.ok(finish)
  finish({
    send() {
      sent++
    },
    close() {
      closed++
    },
  })
  await Promise.resolve()
  assert.equal(closed, 1)
  assert.equal(sent, 0)
})

test('非原生直接只读内存活动，不查询runtime/info、历史或加载会话', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') {
      assert.equal((params.clientInfo as { name: string }).name, 'litch-power-observer')
      return {}
    }
    assert.equal(method, 'litch/internal/power/activity')
    assert.deepEqual(params, {})
    return {
      threads: [
        { threadId: 'a', active: true, background: false },
        { threadId: 'b', active: false, background: true },
      ],
    }
  })
  const result = await probePower({ id: 'pi', running: true, connect: fake.connect }, options())
  assert.deepEqual([...result.active], ['a'])
  assert.equal(result.background.get('b'), true)
  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ['initialize', 'initialized', 'litch/internal/power/activity'],
  )
})

test('已加载清单补齐子线程和临时会话并分页，只读缺失线程', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'runtime/info') return { extensions: ['backgroundTasks'] }
    if (method === 'thread/loaded/list')
      return params.cursor
        ? { data: ['ephemeral'], nextCursor: null }
        : { data: ['parent', 'child'], nextCursor: 'next' }
    assert.equal(method, 'thread/read')
    assert.equal(params.includeTurns, false)
    return {
      thread: {
        id: params.threadId,
        status: { type: params.threadId === 'parent' ? 'idle' : 'active' },
      },
    }
  })
  const result = await probePower(
    { id: 'codex', native: true, running: true, connect: fake.connect },
    options(),
  )
  assert.deepEqual([...result.active], ['child', 'ephemeral'])
  assert.equal(result.complete, true)
  assert.equal(fake.calls.filter((call) => call.method === 'thread/read').length, 3)
  assert.equal(
    fake.calls.some((call) => call.method === 'thread/resume'),
    false,
  )
})

test('已加载清单失败仍核对已知线程，单线程读取失败不伪造空闲', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'runtime/info') return { extensions: ['backgroundTasks'] }
    if (method === 'thread/list') return { data: [], nextCursor: null }
    if (method === 'thread/read' && params.threadId === 'known')
      return { thread: thread('known', 'active') }
    throw new Error('断线或不支持')
  })
  const result = await probePower(
    { id: 'codex', native: true, running: true, connect: fake.connect },
    { ...options(), knownThreads: ['known', 'unread'] },
  )
  assert.equal(result.complete, false)
  assert.deepEqual([...result.active], ['known'])
  assert.deepEqual([...result.unread], ['unread'])
})

test('周期没有已知工作时零连接，有已知工作时只读指定线程不发现外部新回合', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') return {}
    if (method === 'runtime/info') return { extensions: ['backgroundTasks'] }
    assert.equal(method, 'thread/read')
    assert.equal(params.threadId, 'known')
    return { thread: thread('known', 'active') }
  })
  const harness = { id: 'codex', native: true, running: true, connect: fake.connect }
  await probePower(harness, { ...options(), mode: 'known', knownThreads: [] })
  assert.equal(fake.calls.length, 0)
  const result = await probePower(harness, { ...options(), mode: 'known', knownThreads: ['known'] })
  assert.deepEqual([...result.active], ['known'])
  assert.equal(
    fake.calls.some(
      (call) => call.method === 'thread/loaded/list' || call.method === 'thread/list',
    ),
    false,
  )
})

test('非原生周期内存查询必须限定已知ID，缺失应答标unknown而非结束', async () => {
  const fake = rig((method, params) => {
    if (method === 'initialize') return {}
    assert.equal(method, 'litch/internal/power/activity')
    assert.deepEqual(params, { threadIds: ['known', 'missing'] })
    return { threads: [{ threadId: 'known', active: false, background: false }] }
  })
  const result = await probePower(
    { id: 'pi', running: true, connect: fake.connect },
    { ...options(), mode: 'known', knownThreads: ['known', 'missing'] },
  )
  assert.equal(result.background.get('known'), false)
  assert.deepEqual([...result.unread], ['missing'])
})

test('非原生内部查询不偷偷退回全量扫描，也不接收范围外的新会话', async () => {
  const fake = rig((method) => {
    if (method === 'initialize') return {}
    assert.equal(method, 'litch/internal/power/activity')
    return { threads: [{ threadId: 'external', active: true, background: false }] }
  })
  await assert.rejects(
    probePower(
      { id: 'pi', running: true, connect: fake.connect },
      { ...options(), mode: 'known', knownThreads: ['known'] },
    ),
    /线程形状/,
  )
  assert.equal(
    fake.calls.some((call) => call.method === 'thread/list' || call.method === 'runtime/info'),
    false,
  )
})
