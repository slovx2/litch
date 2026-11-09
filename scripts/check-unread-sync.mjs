// 用法：node --import tsx --test scripts/check-unread-sync.mjs
// 桌面和手机共用 createCore。两个独立核心经真实 JSON-RPC 设备入口验收，不在客户端伪造已读响应。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCore, createTransportPair } from '../packages/core/src/index.mts'
import { thread } from '../packages/core/test/fixtures.mts'
import { fakeClock } from '../packages/core/test/helpers.mts'
import { FakeUpstream } from '../packages/device/test/fake-upstream.mts'
import { rig } from '../packages/device/test/helpers.mts'
import { THREAD_READ_STATE as RPC } from '../packages/protocol/src/thread-read-state.mts'

const until = async (check, message) => {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

test('双核心端到端冒烟：互清、新结果、离线完成、重连补齐和未声明连接隔离', async () => {
  const upstream = new FakeUpstream('pi', [thread({ id: 'a', preview: '两个客户端' })])
  const env = rig({ pi: upstream })
  const clients = []
  function client() {
    const time = fakeClock()
    let disconnect = () => {}
    const rows = new Map()
    const core = createCore({
      clock: time.clock,
      version: '9.9.9',
      devices: [
        {
          id: 'local',
          name: '同一设备',
          kind: 'local',
          host: 'test',
          target: null,
          wire: 'green',
          async open() {
            const [front, back] = createTransportPair()
            const handlers = env.device.attach({
              send: (text) => back.send(text),
              close: () => back.close(),
            })
            back.listen({
              message: (text) => handlers.message(text),
              close: () => handlers.close('client disconnected'),
            })
            disconnect = () => back.close()
            return front
          },
        },
      ],
    })
    core.subscribe(
      { kind: 'sidebar', deviceId: 'local' },
      {
        snapshot(data) {
          rows.clear()
          for (const row of data.sessions) rows.set(row.id, row)
        },
        delta(ops) {
          for (const op of ops) {
            if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
            else if (op.op === 'session.remove') rows.delete(op.sessionId)
          }
        },
        error(error) {
          assert.fail(JSON.stringify(error))
        },
      },
    )
    core.start()
    const result = {
      core,
      rows,
      mark: () =>
        core.command(
          'session.markRead',
          { deviceId: 'local', sessionId: 'a' },
          { aborted: false, addEventListener() {} },
        ),
      drop: () => disconnect(),
      reconnect: () => time.advance(30_000),
    }
    clients.push(result)
    return result
  }
  try {
    const desktop = client()
    const phone = client()
    const legacy = env.connect()
    await legacy.initialize(['harness'])
    await until(() => desktop.rows.has('a') && phone.rows.has('a'), '两个核心未完成目录加载')
    const link = await env.device.openEngineLink('pi')
    const source = upstream.live.at(-1)
    const complete = (id) =>
      source.send({
        method: 'turn/completed',
        params: { threadId: 'a', turn: { id, status: 'completed', items: [] } },
      })
    complete('one')
    await until(
      () => desktop.rows.get('a')?.unread === true && phone.rows.get('a')?.unread === true,
      '新回合未同步未读',
    )
    await desktop.mark()
    await until(() => phone.rows.get('a')?.unread === false, '桌面已读未同步到手机')
    complete('two')
    await until(
      () => desktop.rows.get('a')?.unread === true && phone.rows.get('a')?.unread === true,
      '新回答未重新未读',
    )
    await phone.mark()
    await until(() => desktop.rows.get('a')?.unread === false, '手机已读未同步到桌面')
    phone.drop()
    await new Promise((resolve) => setImmediate(resolve))
    complete('three')
    await until(() => desktop.rows.get('a')?.unread === true, '设备未记录离线期间完成回合')
    phone.reconnect()
    await until(() => phone.rows.get('a')?.unread === true, '手机重连未补齐未读')
    desktop.drop()
    await new Promise((resolve) => setImmediate(resolve))
    await phone.mark()
    desktop.reconnect()
    await until(() => desktop.rows.get('a')?.unread === false, '桌面重连未补齐其他端已读')
    assert.equal(
      legacy.notifications.some((n) => n.method === RPC.changed),
      false,
    )
    link.close()
  } finally {
    for (const { core } of clients) core.stop()
    await env.close()
  }
})
