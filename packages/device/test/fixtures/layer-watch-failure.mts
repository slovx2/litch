// 仅供 socket-shutdown 回归子进程预加载：固定制造“监听没有事件”，缩短等待，不改变原用例断言。
import fs, { type FSWatcher } from 'node:fs'
import http from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import { TestClient } from '../helpers.mjs'

const watch = fs.watch as (...args: unknown[]) => FSWatcher
fs.watch = ((path: string, options: object) => watch(path, options, () => {})) as typeof fs.watch
syncBuiltinESMExports()

const waitFor = TestClient.prototype.waitFor
TestClient.prototype.waitFor = function (predicate, timeoutMs) {
  return waitFor.call(this, predicate, Math.min(timeoutMs ?? 3000, 10))
}

// 每个监听端都留一条尚未发 HTTP 的连接，包括两个上游和设备入口。
// 不主动清理这些客户端：只有被测服务端确实回收连接，子进程才能自行退出。
const createServer = http.createServer
http.createServer = ((...args: Parameters<typeof createServer>) => {
  const server = createServer(...args)
  server.once('listening', () => {
    const address = server.address()
    if (typeof address !== 'string') throw new Error('回归夹具只接受 unix 套接字')
    const socket = net.createConnection(address)
    socket.once('connect', () => process.stdout.write('raw socket connected\n'))
    socket.on('error', (error) => {
      throw error
    })
  })
  return server
}) as typeof http.createServer
