import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClientToolHost } from '../../client-tools/host.mjs'
import { CLIENT_TOOL, type ClientToolInvocation } from '../../client-tools/types.mjs'
import { type HelperChannel, HelperClient } from '../helper-client.mjs'
import { FrameReader } from '../wire.mjs'

test('取消与超时都把动作编号送给助手，不只是丢弃本地 Promise', async () => {
  for (const timeout of [false, true]) {
    const frames: any[] = []
    const reader = new FrameReader()
    const channel: HelperChannel = {
      onData: () => {},
      onClose: () => {},
      close: () => {},
      write(data) {
        reader.push(data)
        for (let frame = reader.next(); frame !== undefined; frame = reader.next())
          frames.push(frame)
      },
    }
    const client = new HelperClient(channel)
    const controller = new AbortController()
    const response = client.request(
      'typeText',
      { actionId: 'owned-action' },
      timeout ? 5 : 1000,
      controller.signal,
    )
    if (!timeout) controller.abort()
    await assert.rejects(response)
    assert.equal(frames[0].method, 'typeText')
    assert.deepEqual(frames[1], {
      jsonrpc: '2.0',
      method: 'cancelAction',
      params: { actionId: 'owned-action' },
    })
  }
})

test('核心退出也收尾已经返回的工具回合，正常收尾过的不重复', async () => {
  const ended: string[] = []
  const host = createClientToolHost(
    [
      {
        namespace: 'litch_computer',
        call: async () => ({ success: true, contentItems: [] }),
        turnEnded: (turn) => ended.push(turn.turnId),
      },
    ],
    () => {},
  )
  for (const turnId of ['completed', 'orphan']) {
    host.handle({
      type: CLIENT_TOOL,
      op: 'call',
      invocation: {
        id: turnId,
        namespace: 'litch_computer',
        device: { id: 'local' },
        threadId: 's',
        turnId,
      } as ClientToolInvocation,
    })
  }
  await Promise.resolve()
  host.handle({
    type: CLIENT_TOOL,
    op: 'turnEnded',
    deviceId: 'local',
    threadId: 's',
    turnId: 'completed',
  })
  host.reset()
  host.reset()
  assert.deepEqual(ended, ['completed', 'orphan'])
})
