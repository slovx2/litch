import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { OpencodeApi, OpencodeError } from '../src/api.mjs'

test('OpenCode HTTP：同地址的不同 serve 不共用连接，关闭时回收事件流及空闲连接', {
  timeout: 5000,
}, async () => {
  let generation = 1
  const sockets = new Map<Socket, number>()
  const closed: Promise<unknown>[] = []
  const server = createServer((request, response) => {
    if (request.url === '/global/event') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"payload":{"type":"server.connected"}}\n\n')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ generation: sockets.get(request.socket) }))
  })
  server.on('connection', (socket) => {
    sockets.set(socket, generation)
    closed.push(once(socket, 'close'))
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  const first = new OpencodeApi(url, 'first', '1.18.33')
  const second = new OpencodeApi(url, 'second', '1.18.33')
  try {
    for (let n = 0; n < 3; n++) {
      assert.equal((await first.request('GET', '/global/health')).generation, 1)
      await setImmediate()
    }
    // 故意保留上一代的空闲连接，第二代即使地址相同也必须建立自己的连接。
    generation = 2
    for (let n = 0; n < 3; n++) {
      assert.equal((await second.request('GET', '/global/health')).generation, 2)
      await setImmediate()
    }
    const response = await second.events(AbortSignal.timeout(3000))
    const reader = response.body?.getReader()
    assert.ok(reader)
    assert.equal((await reader.read()).done, false)
    const pending = reader.read()
    const rejected = assert.rejects(pending)
    await second.close()
    await rejected
    await first.close()
    await Promise.all(closed)
    assert.equal(sockets.size, 0)
    await second.close()
  } finally {
    await first.close()
    await second.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('OpenCode HTTP：连接重置及 HTTP 错误原样失败，不重发请求', async () => {
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    if (request.url === '/reset') request.socket.destroy()
    else response.writeHead(401).end('denied')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const api = new OpencodeApi(`http://127.0.0.1:${address.port}`, 'secret', '1.18.33')
  try {
    await assert.rejects(
      api.request('POST', '/reset', { body: {} }),
      (error: unknown) => error instanceof OpencodeError && error.status === 0,
    )
    assert.equal(requests, 1)
    await assert.rejects(
      api.request('GET', '/denied'),
      (error: unknown) => error instanceof OpencodeError && error.status === 401,
    )
    assert.equal(requests, 2)
  } finally {
    await api.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
