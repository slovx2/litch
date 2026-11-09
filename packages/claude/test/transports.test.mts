import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { startWebSocketTransport } from '../../shared/src/transports.mjs'

for (const [name, request] of [
  ['未发送 HTTP 的原始连接', ''],
  ['尚未收齐的 HTTP 请求', 'GET / HTTP/1.1\r\nHost: localhost\r\n'],
  ['没有升级的 HTTP 请求', 'GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'],
] as const) {
  test(`传输层关闭会回收${name}`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'transport-close-'))
    const path = join(root, 'runtime.sock')
    const transport = await startWebSocketTransport(
      `unix://${path}`,
      () => {},
      () => {},
    )
    const client = net.createConnection(path)
    context.after(async () => {
      client.destroy()
      await transport.close()
      await rm(root, { recursive: true, force: true })
    })
    await once(client, 'connect')
    if (request) client.write(request)
    const disconnected = once(client, 'close')
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all([transport.close(), transport.close(), disconnected]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`关闭没有回收${name}`)), 1000)
        }),
      ])
      assert.equal(client.destroyed, true)
      await transport.close()
    } finally {
      clearTimeout(timer)
    }
  })
}

test('传输层关闭时断开常驻客户端，不因上游连接未断而挂起', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transport-close-'))
  const socket = join(root, 'app-server.sock')
  const transport = await startWebSocketTransport(
    `unix://${socket}`,
    () => {},
    () => {},
  )
  const client = new WebSocket(`ws+unix:${socket}`)
  try {
    await new Promise((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    const closed = new Promise((resolve) => client.once('close', resolve))
    // 客户端保持连接；close() 须主动断开它并在限定时间内完成。
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      transport.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('transport.close() 挂起')), 3000)
      }),
    ]).finally(() => clearTimeout(timer))
    await closed
  } finally {
    client.terminate()
    await rm(root, { recursive: true, force: true })
  }
})
