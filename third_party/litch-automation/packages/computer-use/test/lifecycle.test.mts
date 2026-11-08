import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { type HelperChannel, HelperClient } from '../src/helper-client.mjs'
import { WinLauncher } from '../src/launcher-win.mjs'
import { HelperSupervisor } from '../src/supervisor.mjs'
import { encodeFrame } from '../src/wire.mjs'

test('连接尚未建立时 dispose：迟到握手后仍发送 shutdown 并等待进程收尾', async () => {
  let data: (bytes: Buffer) => void = () => {}
  let closed = false
  let waited = false
  const methods: string[] = []
  const channel: HelperChannel = {
    onData(fn) {
      data = fn
    },
    onClose() {},
    close() {
      closed = true
    },
    write(bytes) {
      const message = JSON.parse(bytes.subarray(4).toString()) as { id: number; method: string }
      methods.push(message.method)
      queueMicrotask(() => data(encodeFrame({ jsonrpc: '2.0', id: message.id, result: {} })))
    },
  }
  const client = new HelperClient(channel)
  let connect: (value: HelperClient) => void = () => {}
  const supervisor = new HelperSupervisor({
    lang: () => 'en',
    launcher: {
      respawn: 'onDemand',
      establish: async () =>
        new Promise((resolve) => {
          connect = resolve
        }),
      afterShutdown: async () => {
        waited = true
      },
    },
  })
  const connecting = supervisor.client()
  const rejected = assert.rejects(connecting, /shut down/)
  const disposing = supervisor.dispose()
  connect(client)
  await disposing
  await rejected
  assert.deepEqual(methods, ['shutdown'])
  assert.equal(closed, true)
  assert.equal(waited, true)
})

test('Windows 第二助手在握手前以 3 退出时给出明确 busy，不尝试其他实例', async () => {
  let starts = 0
  const launcher = new WinLauncher({
    productName: 'Second Host',
    exePath: '/unused',
    version: null,
    spawn() {
      starts++
      return spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    },
  })
  await assert.rejects(
    launcher.establish('en', () => {}),
    /Computer Use is busy/,
  )
  assert.equal(starts, 1)
})
