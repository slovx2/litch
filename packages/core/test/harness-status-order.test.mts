import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type AppOp, createRpc, type TransportHandlers } from '../src/index.mjs'
import { deviceWorld } from './device-world.mjs'
import { harness, infoOf } from './fake-device.mjs'
import { fakeClock, settle } from './helpers.mjs'

const DOWN = { kind: 'disconnected', message: '运行时连接断开' }

test('同批 SSH 数据中，快照边界先于其后通知，不能在 Promise 恢复时清掉新通知', async () => {
  let receive: TransportHandlers | undefined
  let id: unknown
  const pending = new Map<string, string>()
  const rpc = createRpc(
    {
      listen: (handlers) => {
        receive = handlers
      },
      send: (text) => {
        id = JSON.parse(text).id
      },
      close() {},
    },
    {
      clock: fakeClock().clock,
      notification: (_method, params) => {
        pending.set('codex', String(params))
      },
      close() {},
    },
  )
  const reply = rpc.request('runtime/info', {}, { received: () => pending.clear() })
  receive?.message(JSON.stringify({ method: 'state', params: 'old' }))
  receive?.message(JSON.stringify({ id, result: {} }))
  receive?.message(JSON.stringify({ method: 'state', params: 'new' }))
  await reply
  assert.deepEqual([...pending.values()], ['new'])
  rpc.close()
})

test('目录刷新未完成时，harness 的断开和恢复立即生效，不在对账结束时重放', async () => {
  let finish: ((value: unknown) => void) | undefined
  let delay = false
  const w = deviceWorld([harness('codex')], {
    extra: {
      'thread/list': () =>
        delay
          ? new Promise((resolve) => {
              finish = resolve
            })
          : { data: [], nextCursor: null },
    },
  })
  w.core.start()
  await settle()
  delay = true
  const refresh = w.command('device.refresh', {})
  await settle()
  w.set('codex', DOWN)
  await settle()
  assert.equal(w.device()?.harnesses[0]?.state, 'unavailable')
  delay = false
  w.set('codex', null)
  await settle()
  assert.equal(w.device()?.harnesses[0]?.state, 'ready')
  finish?.({ data: [], nextCursor: null })
  await refresh
  await settle()
  assert.equal(w.device()?.harnesses[0]?.state, 'ready')
  w.core.stop()
})

test('重连时 runtime/info 的最新快照不会被握手期间的旧不可用通知盖回去', async () => {
  const codex = harness('codex')
  const w = deviceWorld([codex], {
    extra: {
      'runtime/info': () => {
        w.set('codex', DOWN)
        // 模拟通知之后取到的新快照；它已经恢复，旧通知不应再被应用。
        codex.down = null
        return { device: { extensions: ['harness'] }, harnesses: [infoOf(codex)] }
      },
    },
  })
  const states: string[] = []
  w.core.subscribe(
    { kind: 'app' },
    {
      snapshot() {},
      error() {},
      delta(ops) {
        for (const op of ops as AppOp[]) {
          if (op.op === 'device.upsert' && op.device.connection === 'online')
            states.push(op.device.harnesses[0]?.state ?? 'missing')
        }
      },
    },
  )
  w.core.start()
  await settle()
  for (let i = 0; i < 3; i++) {
    w.peer.last().drop()
    await settle()
    w.time.advance(60_000)
    await settle()
  }
  assert.equal(w.peer.servers.length, 4)
  assert.ok(states.length > 0)
  assert.deepEqual([...new Set(states)], ['ready'])
  w.core.stop()
})

test('身份识别还在读设置时收到的新状态，必须在首次上线前应用', async () => {
  let finish: ((value: unknown) => void) | undefined
  const w = deviceWorld([harness('codex')], {
    prepare: (device) => {
      device.extensions.push('deviceSettings')
    },
    extra: {
      'litch/device/settings/read': () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    },
  })
  w.core.start()
  await settle()
  assert.ok(finish)
  w.set('codex', { kind: 'notInstalled', message: '未安装 Codex' })
  await settle()
  finish({ schema: { settings: [] }, snapshot: { version: 1, values: {}, explicit: [] } })
  await settle()
  assert.equal(w.device()?.connection, 'online')
  assert.equal(w.device()?.harnesses[0]?.down, 'notInstalled')
  await w.command('device.refresh', {})
  assert.equal(w.device()?.harnesses[0]?.down, 'notInstalled')
  w.core.stop()
})

test('连接摘要只记状态变化，目录刷新有开始和结束，重复状态通知不刷日志', async () => {
  const w = deviceWorld([harness('codex')])
  w.core.start()
  await settle()
  w.set('codex', DOWN)
  w.set('codex', DOWN)
  await settle()
  w.set('codex', null)
  await settle()
  assert.deepEqual(
    w.traces.filter((entry) => entry.event === 'harness.state').map((entry) => entry.fields.state),
    ['ready', 'unavailable', 'ready'],
  )
  assert.ok(
    w.traces.some((entry) => entry.event === 'connection' && entry.fields.state === 'online'),
  )
  const catalog = w.traces.filter((entry) => entry.event === 'catalog')
  assert.deepEqual(
    catalog.map((entry) => entry.fields.phase),
    ['start', 'end', 'start', 'end'],
  )
  assert.ok(
    catalog
      .filter((entry) => entry.fields.phase === 'end')
      .every((entry) => entry.fields.result === 'ok'),
  )
  w.core.stop()
})
