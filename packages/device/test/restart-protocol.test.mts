import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSystemMessage } from '../../protocol/src/system-messages.mjs'
import { FakeControl, managed } from './fake-control.mjs'
import { FakeEngine } from './fake-engine.mjs'
import { rig, settle } from './helpers.mjs'

function control(pid: number): FakeControl {
  const value = new FakeControl([managed('pi')])
  value.service = {
    pid,
    startedAt: `start-${pid}`,
    version: '9.9.9',
    root: '/isolated',
    detached: true,
  }
  value.push()
  return value
}

test('设备协议：明确准备后重建设备，在原线程发送一次标准文本；无需新扩展', async () => {
  const engine = new FakeEngine('pi')
  const oldControl = control(1)
  let env = rig({ pi: engine }, {}, { control: oldControl, wrapUpReminder: false })
  try {
    const client = env.connect()
    await client.initialize()
    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    const { turn } = await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '原任务' }],
    })
    assert.deepEqual(await oldControl.onAsk?.('restart.prepare'), { prepared: 1 })
    assert.equal(engine.turns.get(thread.id)?.[0]?.status, 'interrupted')
    await env.device.close()
    env = rig(
      { pi: engine },
      {},
      { stateDir: env.stateDir, control: control(2), wrapUpReminder: false },
    )
    for (let attempt = 0; attempt < 100 && engine.turns.get(thread.id)?.length !== 2; attempt++)
      await settle()
    const turns = engine.turns.get(thread.id) ?? []
    assert.equal(turns.length, 2)
    assert.equal(turns[0]?.id, turn.id)
    const sent = engine.seen.filter((frame) => frame.method === 'turn/start')
    assert.equal(sent.length, 2)
    const input = sent[1]?.params
    assert.deepEqual(Object.keys(input).sort(), ['input', 'threadId'])
    assert.equal(parseSystemMessage(input.input[0].text)?.kind, 'restart')
    await env.device.restart.recover()
    assert.equal(engine.seen.filter((frame) => frame.method === 'turn/start').length, 2)
  } finally {
    await env.close()
  }
})

test('设备协议：客户端停止撤销资格，普通停止也不会留下恢复票', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  try {
    const client = env.connect()
    await client.initialize()
    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    const { turn } = await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '原任务' }],
    })
    await client.call('turn/interrupt', { threadId: thread.id, turnId: turn.id })
    assert.deepEqual(await ctl.onAsk?.('restart.prepare'), { prepared: 0 })
    await ctl.onAsk?.('restart.cancel')
  } finally {
    await env.close()
  }
})

test('真实内部连接在异步配额等待后再检查停止，撤票后没有恢复 turn/start', async () => {
  const engine = new FakeEngine('pi')
  const ctl = control(1)
  const env = rig({ pi: engine }, {}, { control: ctl, wrapUpReminder: false })
  let release = () => {}
  try {
    const client = env.connect()
    await client.initialize()
    const { thread } = await client.call('thread/start', { harness: 'pi', cwd: env.stateDir })
    await client.call('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: '原任务' }],
    })
    await ctl.onAsk?.('restart.prepare')
    let arrived = () => {}
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = env.device.managers.lines.reserve.bind(env.device.managers.lines)
    env.device.managers.lines.reserve = async (...args) => {
      arrived()
      await gate
      return original(...args)
    }
    const recovery = env.device.restart.recover('pi')
    await waiting
    // 用户的停止在内部请求获得配额前到达；即使目标旧回合已结束，撤销也必须先发生。
    await client.call('turn/interrupt', { threadId: thread.id }).catch(() => {})
    release()
    await recovery
    assert.equal(engine.seen.filter((frame) => frame.method === 'turn/start').length, 1)
  } finally {
    release()
    await env.close()
  }
})
