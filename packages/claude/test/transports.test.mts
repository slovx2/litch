import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'
import { startWebSocketTransport } from '../../shared/src/transports.mjs'

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
