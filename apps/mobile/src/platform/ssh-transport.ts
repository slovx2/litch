// 远程设备的传输：手机端 SSH 模块（modules/litch-ssh）在本机回环上开一个 WebSocket 入口，
// 这边用 RN 自带的 WebSocket 连上去，包成核心要的传输接口。打开的顺序和桌面端一样
// （apps/desktop/src/transport-ssh.mts 开头）：
//   1. 先直接接代理，接哪一种由对面当场认（先适配器、后 codex）。服务本来就在跑时一条 ssh 就连上了
//   2. 没接上：看对面有什么，定下连哪一种；不够格的在这里给出明确的原因
//   3. 让那一种的服务常驻（已经在跑就什么都不做）
//   4. 再接一次
// 连上之后 SSH 模块每 15 秒发一次心跳，没回音就关掉连接，这边收到关闭，核心照常走重连。

import {
  type AbortSignalLike,
  type Clock,
  ConnectError,
  phrase,
  type RemoteCheck,
  type RemoteStopResult,
  type Text,
  type Transport,
  type TransportHandlers,
  type TransportOpener,
  toConnectError,
} from '@litch/core'
import { getRandomBytes } from 'expo-crypto'
import { type SshTarget, ssh } from '../../modules/litch-ssh/src'
import { noteWork } from '../probe'
import { sshFailure } from './ssh-errors'
import { checkAborted, notInstalled, peekHarnesses, probe, startPeer, stopPeer } from './ssh-probe'
import { EXIT, type Peer, proxyScript, type ScriptNames } from './ssh-script'

export interface RemoteConfig {
  target: SshTarget
  /** 远端适配器的命令名 */
  adapter: string
  /** 远端 codex 的命令名。不给就是 codex */
  codex?: string
  /** 新建会话用的工作目录。不给就由对面定（只有测试夹具给） */
  work?: string
}

/** 每次连都现取一份：钥匙、记下的主机指纹可能刚换过 */
export type ConfigSource = RemoteConfig | (() => Promise<RemoteConfig>)

const randomHex = (): string =>
  Array.from(getRandomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('')

const namesOf = (config: RemoteConfig): ScriptNames => ({
  adapter: config.adapter,
  codex: config.codex ?? 'codex',
  randomHex,
})

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
      done('握手前连接已断开')
    }
  })
}

function wrap(socket: WebSocket, id: string): Transport {
  let handlers: TransportHandlers | null = null
  const backlog: string[] = []
  let closedWith: { reason: Text | null } | null = null
  const finish = (reason: Text | null) => {
    if (handlers) handlers.close(reason)
    else closedWith = { reason }
  }
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
    if (event.code === 1000) {
      void ssh.closeStream(id)
      finish(null)
      return
    }
    // 心跳没回音、ssh 断了：SSH 模块记着原因，先取了再把流关掉
    void ssh
      .streamState(id)
      .then(
        (state) => (/心跳/.test(state.error) ? phrase('connect.heartbeat') : null),
        () => null,
      )
      .then((heartbeat) => {
        void ssh.closeStream(id)
        finish(heartbeat ?? phrase('connect.closed', { code: event.code ?? 0 }))
      })
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

type Proxy =
  | { ok: true; transport: Transport; peer: Peer }
  | { ok: false; reason: ConnectError | null }

/**
 * 接一次代理。没接上分两种：ssh 自己没连上、或者对面没有要的那个命令，这是有明确原因的（reason）；
 * 别的（多半是对面的服务没在跑）reason 是 null，调用方接着走探测和启动
 */
async function openProxy(config: RemoteConfig, which: Peer | 'auto'): Promise<Proxy> {
  const id = `remote-${++streams}`
  const script = proxyScript(namesOf(config), which)
  let url: string
  try {
    url = await ssh.openStream(id, config.target, script.text, script.marker)
  } catch (error) {
    return { ok: false, reason: sshFailure(error) }
  }
  const socket = await connect(url)
  if (typeof socket !== 'string') {
    const state = await ssh.streamState(id)
    return {
      ok: true,
      transport: wrap(socket, id),
      peer: state.peer === 'codex' ? 'codex' : 'service',
    }
  }
  const state = await ssh.streamState(id)
  void ssh.closeStream(id)
  if (state.code === EXIT.notFound) {
    return { ok: false, reason: which === 'auto' ? notInstalled() : null }
  }
  return { ok: false, reason: null }
}

const resolveConfig = async (source: ConfigSource): Promise<RemoteConfig> =>
  typeof source === 'function' ? await source() : source

export function sshOpener(source: ConfigSource): TransportOpener {
  return async (signal, report) => {
    const config = await resolveConfig(source)
    checkAborted(signal)
    const names = namesOf(config)
    report?.(phrase('ssh.step.connect'))
    const first = await openProxy(config, 'auto')
    if (first.ok) return first.transport
    if (first.reason) throw first.reason
    checkAborted(signal)

    report?.(phrase('ssh.step.probe'))
    const found = await probe(config, names, signal)
    const service = found.peer === 'service'
    report?.(phrase(service ? 'ssh.step.startService' : 'ssh.step.start'))
    await startPeer(config, names, found.peer, signal)

    report?.(phrase('ssh.step.connect'))
    const second = await openProxy(config, found.peer)
    if (second.ok) return second.transport
    throw (
      second.reason ??
      new ConnectError(
        'startFailed',
        phrase(service ? 'remote.serviceProxyFailed' : 'remote.proxyFailed'),
        true,
      )
    )
  }
}

/**
 * 添加之前先看一眼。不启动任何东西；任何失败都收成结果交回去，不往外抛。
 * 对面的设备服务这会儿在跑的话，顺便接上去问一句上面有哪些 harness
 */
export async function checkRemote(
  source: ConfigSource,
  signal: AbortSignalLike,
  clock: Clock,
  version: string,
): Promise<RemoteCheck> {
  try {
    const config = await resolveConfig(source)
    const found = await probe(config, namesOf(config), signal)
    if (found.peer === 'codex') {
      return { ok: true, peer: 'codex', version: found.version, system: found.system }
    }
    let harnesses = null
    if (found.running) {
      const opened = await openProxy(config, 'service').catch(() => null)
      if (opened?.ok) harnesses = await peekHarnesses(opened.transport, clock, version)
    }
    return {
      ok: true,
      peer: 'service',
      version: found.version,
      system: found.system,
      running: found.running,
      harnesses,
    }
  } catch (error) {
    const failure = toConnectError(error)
    return {
      ok: false,
      failure: {
        stage: failure.stage,
        text: failure.text,
        detail: failure.detail,
        retrying: false,
        ...(failure.guide ? { guide: failure.guide } : {}),
      },
    }
  }
}

/** 请对面的设备服务停下（重启设备服务的第一步）。停了之后由核心重连，连的时候 device-start 把它拉起来 */
export async function stopRemote(
  source: ConfigSource,
  ifIdle: boolean,
  signal: AbortSignalLike,
): Promise<RemoteStopResult> {
  const config = await resolveConfig(source)
  return stopPeer(config, namesOf(config), ifIdle, signal)
}
