import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
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
    // Linux 主动销毁尚有 HTTP 数据的连接时会先报 ECONNRESET，再报 close。
    // events.once(close) 会把 error 当成拒绝；单独等 close，并核对错误，不能吞掉其他故障。
    const errors: NodeJS.ErrnoException[] = []
    client.on('error', (error: NodeJS.ErrnoException) => errors.push(error))
    const disconnected = new Promise<void>((resolve) => client.once('close', () => resolve()))
    if (request) client.write(request)
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        Promise.all([transport.close(), transport.close(), disconnected]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`关闭没有回收${name}`)), 1000)
        }),
      ])
      assert.equal(client.destroyed, true)
      for (const error of errors) assert.equal(error.code, 'ECONNRESET', error.message)
      assert.equal(existsSync(path), false, '关闭完成后不再留下监听套接字')
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
