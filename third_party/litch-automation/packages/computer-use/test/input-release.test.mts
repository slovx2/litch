import assert from 'node:assert/strict'
import test from 'node:test'
import { type HelperAccess, releaseComputerInput } from '../src/executor-shared.mjs'

test('交还只发送本会话本回合的输入释放，不结束回合、不启动助手', async () => {
  const calls: unknown[] = []
  const helper: HelperAccess = {
    client: async () => {
      throw new Error('不能为交还启动助手')
    },
    restart: async () => {
      throw new Error('不能重启助手')
    },
    connected: {
      request: async (...args) => {
        calls.push(args)
      },
    },
  }
  await releaseComputerInput(helper, {
    deviceId: 'desktop',
    threadId: 'session-a',
    turnId: 'turn-a',
  })
  assert.deepEqual(calls, [
    ['releaseInput', { session: 'desktop/session-a', turnId: 'turn-a' }, 5000],
  ])
  await releaseComputerInput(
    { ...helper, connected: null },
    { deviceId: 'desktop', threadId: 'session-a', turnId: 'turn-a' },
  )
  assert.equal(calls.length, 1)
})

test('交还失败传回调用方，不能把释放 Chrome 标签误报为完整交接', async () => {
  const helper: HelperAccess = {
    client: async () => {
      throw new Error('unexpected')
    },
    restart: async () => {},
    connected: {
      request: async () => {
        throw new Error('previous input is still being released')
      },
    },
  }
  await assert.rejects(
    releaseComputerInput(helper, { deviceId: 'desktop', threadId: 'session-a', turnId: 'turn-a' }),
    /still being released/,
  )
})
