import assert from 'node:assert/strict'
import { test } from 'node:test'
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
