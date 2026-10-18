// 本机设备的传输：直接连套接字文件，上面跑 WebSocket，一帧一条 JSON。
// 这条路上没有 SSH，没有 TCP，不占端口。
import { createConnection } from 'node:net'
import { ConnectError, phrase, type Transport, type TransportOpener } from '@litch/core'
import { WebSocket } from 'ws'
import { MAX_PAYLOAD, wrapSocket } from './transport-ws.mjs'

/** 握手阶段等多久。对面在本机，正常是几毫秒的事 */
const OPEN_TIMEOUT_MS = 5000

function reasonOf(error: NodeJS.ErrnoException, path: string): ConnectError {
  if (error.code === 'ENOENT') {
    return new ConnectError('unreachable', phrase('connect.socketMissing', { path }))
  }
  if (error.code === 'ECONNREFUSED') {
    // 文件还在但没人监听，多半是服务异常退出留下的
    return new ConnectError('unreachable', phrase('connect.socketRefused', { path }))
  }
  if (error.code === 'EACCES') {
    return new ConnectError('unreachable', phrase('connect.socketDenied', { path }), false)
  }
  return new ConnectError('unreachable', error.message)
}

/** path 是套接字文件的绝对路径 */
export function unixSocketOpener(path: string): TransportOpener {
  return (signal) =>
    new Promise<Transport>((resolve, reject) => {
      // 路径不写进地址里：地址里的路径会被转义，空格、中文都变成 %xx，拿转义过的去连就是“没有这个文件”。
      // 地址只是个摆设，连哪里由 createConnection 定
      const socket = new WebSocket('ws://localhost/', {
        createConnection: () => createConnection(path),
        handshakeTimeout: OPEN_TIMEOUT_MS,
        perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD,
      })
      let settled = false
      const fail = (error: ConnectError) => {
        if (settled) return
        settled = true
        socket.terminate()
        reject(error)
      }
      socket.once('open', () => {
        if (settled) return
        settled = true
        socket.removeAllListeners('error')
        resolve(wrapSocket(socket))
      })
      socket.once('error', (error) => fail(reasonOf(error, path)))
      signal.addEventListener(
        'abort',
        () => fail(new ConnectError('unreachable', phrase('connect.cancelled'))),
        {
          once: true,
        },
      )
    })
}
