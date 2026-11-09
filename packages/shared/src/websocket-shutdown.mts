import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import type { WebSocketServer } from 'ws'

/** 从开始监听前登记所有连接；未发 HTTP、请求未收齐的连接不在 wss.clients 中。 */
export function websocketShutdown(server: Server, wss: WebSocketServer): () => Promise<void> {
  const sockets = new Set<Socket>()
  let closing: Promise<void> | undefined
  server.on('connection', (socket) => {
    if (closing) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  return () => {
    closing ??= Promise.resolve().then(async () => {
      // 先停止接受连接，再终止现有连接；不等对端完成 HTTP 或 WebSocket 关闭握手。
      const httpClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      const wsClosed = new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()))
      })
      for (const client of wss.clients) client.terminate()
      for (const socket of sockets) socket.destroy()
      await Promise.all([httpClosed, wsClosed])
    })
    return closing
  }
}
