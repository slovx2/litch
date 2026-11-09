// 套接字文件的路径里有空格、有中文时也要连得上。
// 用户的主目录就可能是这样（macOS 上带空格的全名、中文的用户名），状态目录默认在主目录下面。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { listenUnix, unixConnector } from '../src/sockets.mjs'
import { tempDir } from './helpers.mjs'

test('套接字的路径里有空格和中文：监听得起来，连得上，帧对得上', async () => {
  const root = tempDir()
  const directory = join(root, '张 三')
  mkdirSync(directory)
  const path = join(directory, 'runtime.sock')
  const received: string[] = []
  const listener = await listenUnix(path, (wire) => ({
    message(text) {
      received.push(text)
      wire.send(`收到：${text}`)
    },
    close() {},
  }))
  try {
    let answered: (text: string) => void = () => {}
    const answer = new Promise<string>((resolve) => {
      answered = resolve
    })
    // 连不上的话在这里就抛出来，不会干等那一句回话
    const wire = await unixConnector(path)({ message: answered, close() {} })
    wire.send('你好')
    assert.equal(await answer, '收到：你好')
    wire.close()
    assert.deepEqual(received, ['你好'])
  } finally {
    await listener.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('只发送超大帧头就明确报告100MiB上限，不退化成1006', async () => {
  const { createHash } = await import('node:crypto')
  const { createServer } = await import('node:http')
  const root = tempDir()
  const path = join(root, 'oversized.sock')
  const server = createServer()
  let peer: import('node:stream').Duplex | undefined
  server.on('upgrade', (request, socket) => {
    peer = socket
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    // 声明101MiB，不分配正文、不落盘。ws会在读取长度时拒绝。
    const header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(101n * 1024n * 1024n, 2)
    socket.write(header)
    socket.on('data', () => socket.end())
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  try {
    let report!: (reason: string) => void
    const closed = new Promise<string>((resolve) => {
      report = resolve
    })
    await unixConnector(path)({ message: () => assert.fail('不能收到超大正文'), close: report })
    assert.match(await closed, /100 MiB.*分页/)
  } finally {
    peer?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
