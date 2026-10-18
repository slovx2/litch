// unix 套接字上的 WebSocket：聚合面的监听端，和连到运行时的客户端。
// Windows 上同一套东西走命名管道（\\.\pipe\名字），Go 层传过来的地址写成 pipe://，net 模块两样都认。
// 线上格式和运行时一样（packages/shared/src/transports.mts）：HTTP 升级成 WebSocket，每帧一条 JSON。
// 没有直接用 shared 里的那个监听函数，是因为路由要拿到每帧的原文、也要能把原文原样发出去，
// 那个函数只给解析之后的对象。
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { type RawData, WebSocket, WebSocketServer } from 'ws'
import { ensureParent } from '../../shared/src/util.mjs'
import type { Connector, Wire, WireHandlers } from './wire.mjs'

function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

function wireOf(ws: WebSocket): Wire {
  return {
    send(text, flushed) {
      if (ws.readyState !== WebSocket.OPEN) return
      // 对面刚好在这一刻断开时 send 会抛错：丢掉这一帧，断开的事由 close 事件处理
      try {
        if (flushed) ws.send(text, (error) => (error ? undefined : flushed()))
        else ws.send(text)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== 'EPIPE' && code !== 'ECONNRESET' && code !== 'EBADF') throw error
      }
    },
    close() {
      ws.close()
    },
    backlog() {
      return ws.bufferedAmount
    },
  }
}

/** 连到一个运行时的套接字。地址写法和启动参数一致：unix://路径（Windows 上是 pipe://命名管道） */
export function unixConnector(path: string): Connector {
  return (handlers) =>
    new Promise<Wire>((resolve, reject) => {
      // 路径不写进地址里：地址里的路径会被转义，空格、中文都变成 %xx，拿转义过的去连就是“没有这个文件”
      // （主目录带空格或中文的用户，状态目录的路径就是这样）。地址只是个摆设，连哪里由 createConnection 定
      const ws = new WebSocket('ws://localhost/', {
        perMessageDeflate: false,
        createConnection: () => net.createConnection(path),
      })
      let opened = false
      ws.on('message', (data) => handlers.message(textOf(data)))
      ws.once('open', () => {
        opened = true
        resolve(wireOf(ws))
      })
      ws.on('error', (error) => {
        // 连上之前的错误就是“连不上”；连上之后的错误后面一定跟着 close，在那里报
        if (!opened) reject(error)
      })
      ws.once('close', (code, reason) => {
        if (opened) handlers.close(reason.toString('utf8') || `连接关闭（${code}）`)
      })
    })
}

/** 这个套接字文件后面有没有进程在听 */
function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export interface Listener {
  close(): Promise<void>
}

/**
 * 在 unix 套接字上提供聚合面。套接字文件只有属主可读写：
 * 能连上它就等同于拥有这个用户的 shell（终端和文件都不加沙箱），不能让别的用户连。
 * Windows 上是命名管道：没有文件可删、可改权限，管道用进程令牌的默认安全描述符
 * （系统、管理员和创建者本人完全控制，Everyone 只读，打不开双向的连接，发不了请求）。
 */
export async function listenUnix(
  path: string,
  attach: (wire: Wire) => WireHandlers,
): Promise<Listener> {
  const pipe = isPipePath(path)
  if (pipe) {
    if (await isListening(path)) throw new Error(`聚合面已经有进程在监听：${path}`)
  } else {
    ensureParent(path)
    if (existsSync(path)) {
      // 已经有设备进程在听的话不能抢：把文件删掉重建会让那个进程的客户端全部变成孤儿
      if (await isListening(path)) throw new Error(`聚合面已经有进程在监听：${path}`)
      rmSync(path, { force: true })
    }
  }
  const server = http.createServer()
  const wss = new WebSocketServer({ server, perMessageDeflate: false })
  wss.on('connection', (ws) => {
    const handlers = attach(wireOf(ws))
    ws.on('message', (data) => handlers.message(textOf(data)))
    ws.once('close', () => handlers.close('客户端断开'))
    ws.on('error', () => {})
  })
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', resolve)
      server.listen(path)
    })
  if (pipe) await listen()
  else {
    // 套接字文件的权限在创建时由 umask 决定：先收紧再监听，不留“先建出来再改权限”的空当
    const previous = process.umask(0o077)
    try {
      await listen()
    } finally {
      process.umask(previous)
    }
    chmodSync(path, 0o600)
  }
  return {
    async close() {
      // server.close 会等现有连接结束，先把它们断开
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => {
        wss.close(() => server.close(() => resolve()))
      })
      if (!pipe) rmSync(path, { force: true })
    },
  }
}

const PIPE_PREFIX = '\\\\.\\pipe\\'

/** Windows 的命名管道（\\.\pipe\名字），不是文件 */
export function isPipePath(path: string): boolean {
  return path.startsWith(PIPE_PREFIX)
}

/**
 * 这个套接字在不在。命名管道不能用 existsSync 看：那要打开它，所有实例都被占着时报 EBUSY，
 * 看起来就像不在（Go 层的控制通道就是这样）；列出管道目录不连它
 */
export function socketExists(path: string): boolean {
  if (!isPipePath(path)) return existsSync(path)
  const name = path.slice(PIPE_PREFIX.length).toLowerCase()
  return readdirSync(PIPE_PREFIX).some((entry) => entry.toLowerCase() === name)
}

/** 启动参数里的套接字地址：unix://绝对路径；Windows 上 Go 层给的是 pipe://\\.\pipe\名字 */
export function parseSocketUrl(value: string, what: string): string {
  if (value.startsWith('pipe://')) {
    const path = value.slice('pipe://'.length)
    if (process.platform !== 'win32' || !isPipePath(path))
      throw new Error(`${what} 的 pipe:// 只能是本机 Windows 的命名管道，收到的是 ${value}`)
    return path
  }
  const path = value.startsWith('unix://') ? value.slice('unix://'.length) : ''
  if (!path.startsWith('/')) throw new Error(`${what} 要写成 unix://绝对路径，收到的是 ${value}`)
  return path
}
