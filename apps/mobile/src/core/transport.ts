// 远程设备的传输：手机端 SSH 模块（modules/litch-ssh）在本机回环上开一个 WebSocket 入口，
// 这边用 RN 自带的 WebSocket 连上去，包成核心要的传输接口。和桌面端一样三步走：
// 先直接接代理（服务多半已经在跑）；接不上就让设备服务常驻，再接一次。
import { getRandomBytes } from 'expo-crypto'
import {
  ConnectError,
  type Transport,
  type TransportHandlers,
  type TransportOpener,
} from '../../../../packages/core/src/index.mts'
import { type SshTarget, ssh } from '../../modules/litch-ssh/src'
import { noteWork } from '../probe'
import { EXIT, parsePairs, proxyScript, startScript } from './script'

export interface RemoteConfig {
  target: SshTarget
  /** 远端适配器的命令名 */
  adapter: string
  /** 新建会话用的工作目录。不给就由对面定 */
  work?: string
}

const randomHex = (): string =>
  Array.from(getRandomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('')

let streams = 0

/** 连上本机回环上的入口。没握上手时返回原因 */
function connect(url: string): Promise<WebSocket | string> {
  return new Promise((done) => {
    const socket = new WebSocket(url)
    let settled = false
    socket.onopen = () => {
      settled = true
      done(socket)
    }
    socket.onerror = (event) => {
      if (settled) return
      settled = true
      done((event as unknown as { message?: string }).message ?? '握手失败')
    }
    socket.onclose = () => {
      if (settled) return
      settled = true
      done('握手前就断开了')
    }
  })
}

function wrap(socket: WebSocket, id: string): Transport {
  let handlers: TransportHandlers | null = null
  const backlog: string[] = []
  let closedWith: { reason: string | null } | null = null
  socket.onmessage = (event) => {
    const text = String(event.data)
    if (!handlers) {
      backlog.push(text)
      return
    }
    // 收到一帧到核心处理完（解析、归并、给界面排更新）是同步的，记下来看 JS 线程被谁占着
    const started = performance.now()
    handlers.message(text)
    noteWork('net', performance.now() - started, text.length)
  }
  socket.onclose = (event) => {
    void ssh.closeStream(id)
    const reason = event.code === 1000 ? null : `连接断开（${event.code}${event.reason ? `，${event.reason}` : ''}）`
    if (handlers) handlers.close(reason)
    else closedWith = { reason }
  }
  socket.onerror = () => {}
  return {
    send(text) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text)
    },
    listen(next) {
      handlers = next
      for (const text of backlog.splice(0)) next.message(text)
      if (closedWith) next.close(closedWith.reason)
    },
    close() {
      socket.close()
      void ssh.closeStream(id)
    },
  }
}

async function tryProxy(config: RemoteConfig): Promise<Transport | string> {
  const id = `remote-${++streams}`
  const script = proxyScript({ adapter: config.adapter, randomHex })
  const url = await ssh.openStream(id, config.target, script.text, script.marker)
  const socket = await connect(url)
  if (typeof socket !== 'string') return wrap(socket, id)
  const state = await ssh.streamState(id)
  void ssh.closeStream(id)
  return [state.error, state.stderr.trim(), socket].filter(Boolean).join('；')
}

export function sshOpener(config: RemoteConfig): TransportOpener {
  return async (signal, report) => {
    const first = await tryProxy(config)
    if (typeof first !== 'string') return first
    if (signal.aborted) throw new ConnectError('unreachable', '已取消')
    report?.('启动设备服务')
    const start = startScript({ adapter: config.adapter, randomHex })
    const said = await ssh.runScript(config.target, start.text, start.marker)
    if (said.code === EXIT.notFound) {
      throw new ConnectError('notInstalled', '对面没有装适配器', false, said.stderr)
    }
    const pairs = parsePairs(said.output)
    if (pairs.code !== '0') {
      throw new ConnectError('unreachable', `设备服务没起来（${pairs.code ?? said.code}）`, true, pairs.said ?? said.stderr)
    }
    const second = await tryProxy(config)
    if (typeof second !== 'string') return second
    throw new ConnectError('unreachable', '接不上设备服务', true, second)
  }
}
