import assert from 'node:assert/strict'
import test from 'node:test'
import { RESUME_TOOLS_CHANGED } from '../../protocol/src/resume-tools.mjs'
import type { WireHandlers } from '../src/wire.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig } from './helpers.mjs'

/** 保留传输层回调，显式注入 WebSocket 关闭握手期间已在接收队列里的帧。 */
function queuedFrames() {
  const pi = new FakeEngine('pi')
  const handlers: WireHandlers[] = []
  const connect = pi.connector
  Object.defineProperty(pi, 'connector', {
    value: (receiver: WireHandlers) => {
      handlers.push(receiver)
      return connect(receiver)
    },
  })
  return { pi, handlers }
}

const snapshot = (id: string, revision: number) =>
  JSON.stringify({
    method: RESUME_TOOLS_CHANGED,
    params: {
      threadId: id,
      instance: 'fixture',
      revision,
      dynamicTools: [{ name: `tool-${revision}` }],
    },
  })

test('I-306：设备关库后收到缓冲的工具通知，不再进入任何引擎订阅者或写 SessionStore', async () => {
  const { pi, handlers } = queuedFrames()
  const env = rig({ pi })
  try {
    const link = await env.device.openEngineLink('pi')
    const receiver = handlers.at(-1)
    assert.ok(receiver)
    receiver.message(snapshot('fixture-thread', 1))
    assert.deepEqual(env.device.sessionTree.store.tools('fixture-thread'), [{ name: 'tool-1' }])
    let delivered = 0
    link.onNotification(() => delivered++)
    link.onServerRequest(() => delivered++)
    const client = env.device.attach({
      send: () => {
        delivered++
      },
      close() {},
    })
    await env.device.close()
    assert.doesNotThrow(() => receiver.message(snapshot('fixture-thread', 2)))
    receiver.message(JSON.stringify({ id: 'late', method: 'item/tool/call', params: {} }))
    client.message('缓冲中尚未解析的客户端帧')
    assert.equal(delivered, 0)
    assert.equal(link.closed, true)
  } finally {
    await env.close()
  }
})

test('I-306：关闭开始即隔离内部及客户端连接，不等附件异步收尾', async () => {
  const { pi, handlers } = queuedFrames()
  const env = rig({ pi })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const closeAttachments = env.device.attachments.close.bind(env.device.attachments)
  env.device.attachments.close = async () => {
    await gate
    await closeAttachments()
  }
  let stopping: Promise<void> | undefined
  try {
    const link = await env.device.openEngineLink('pi')
    const receiver = handlers.at(-1)
    assert.ok(receiver)
    receiver.message(snapshot('fixture-thread', 1))
    stopping = env.device.close()
    receiver.message(snapshot('fixture-thread', 2))
    assert.equal(link.closed, true, '第一次 await 前已停止接收')
    assert.deepEqual(env.device.sessionTree.store.tools('fixture-thread'), [{ name: 'tool-1' }])
    await assert.rejects(link.request('thread/start', {}), /shutting down|已经关|已关闭/)
    assert.equal(env.connect().closed, true, '关闭中不能再接入客户端')
  } finally {
    release()
    await stopping
    await env.close()
  }
})

test('I-306：应答刚到但异步续体未运行时关闭，不再记工具清单或启动回合副作用', async () => {
  const { pi, handlers } = queuedFrames()
  const env = rig({ pi })
  try {
    pi.handlers['thread/start'] = () => undefined
    const link = await env.device.openEngineLink('pi')
    const receiver = handlers.at(-1)
    assert.ok(receiver)
    const result = link.request('thread/start', { dynamicTools: [{ name: 'fixture' }] })
    const rejected = assert.rejects(result, /shutting down|已经关|已关闭/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const sent = pi.seen.findLast((frame) => frame.method === 'thread/start')
    assert.ok(sent)
    receiver.message(
      JSON.stringify({ id: sent.id, result: { thread: { id: 'late-thread', turns: [] } } }),
    )
    const stopping = env.device.close()
    await rejected
    await stopping
  } finally {
    await env.close()
  }
})
