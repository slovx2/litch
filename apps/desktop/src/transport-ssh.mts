// 远程设备的传输：经系统的 ssh 接到对面的常驻服务上。
// 对面是那台机器上的设备服务（装了我们的适配器，接它的聚合面，一条连接里是全部 harness），
// 没有的话是原生 codex 自己的常驻服务。两种的线上格式一样：“ssh 标准输入输出里的 WebSocket”，
// 和本机套接字也是同一种，上面的连接层是同一份代码。
// 对面不开任何端口，这边也不监听任何端口；适配器给官方桌面端开的那几个 SSH 端口
// 我们任何情况下都不用：走的是那台机器自己的 SSH 服务，登录后执行代理子命令，接的是套接字文件。
//
// 打开的顺序：
//   1. 先直接接代理子命令，接哪一种由对面当场认（先适配器、后 codex）。对面的服务本来就在跑的话
//      （平时重连都是这种情况），一条 ssh 就连上了。
//   2. 没接上：看对面有什么（适配器在不在、什么版本；codex 在不在、什么版本），定下连哪一种；
//      不够格的在这里给出明确的原因。
//   3. 让那一种的服务在对面常驻（已经在跑就什么都不做），等它就绪。
//   4. 再接一次代理子命令。
// 对面是哪一种不靠这边记：每次都由第 1 步现认。所以对面装上了适配器、卸掉了适配器，下一次连接
// （断线重连、重新打开应用、在设备详情里点“重新连接”）自己就换过去了，没有“记错了”这回事。
// 上一次是哪一种只留在侧栏的快照里，给没连上时显示用。
import { Duplex, PassThrough } from 'node:stream'
import {
  type AbortSignalLike,
  type Clock,
  ConnectError,
  phrase,
  type RemoteCheck,
  type RemoteTarget,
  type Text,
  type Transport,
  type TransportOpener,
  toConnectError,
} from '@litch/core'
import { WebSocket } from 'ws'
import { notInstalled, peekHarnesses, probe, startPeer } from './ssh/probe.mjs'
import { spawnFailure, spawnSsh, sshFailure, tailOf } from './ssh/run.mjs'
import { EXIT, type Peer, proxyScript } from './ssh/script.mjs'
import { MAX_PAYLOAD, wrapSocket } from './transport-ws.mjs'

/** 从起 ssh 到 WebSocket 握完手 */
const PROXY_TIMEOUT_MS = 45_000
const HEARTBEAT = { everyMs: 20_000, timeoutMs: 15_000 }
/** ssh 退了之后，留给管道里剩下的那点数据走完的时间；过了还没收场就直接按断开算 */
const EXIT_GRACE_MS = 250

type Proxy =
  | { ok: true; transport: Transport; peer: Peer }
  | { ok: false; reason: ConnectError | null }

/**
 * 接一次代理子命令。接上了就是一条传输，外加接的是哪一种。
 * which：接哪一种的；auto 是让对面当场认（先适配器、后 codex）。
 * 没接上分两种：ssh 自己没连上、或者对面没有要的那个命令，这是有明确原因的（reason）；
 * 别的（多半是对面的服务没在跑）reason 是 null，调用方接着走探测和启动。
 */
function openProxy(
  target: RemoteTarget,
  signal: AbortSignalLike,
  which: Peer | 'auto',
): Promise<Proxy> {
  return new Promise<Proxy>((resolve, reject) => {
    const script = proxyScript(which)
    const child = spawnSsh(target)
    let stderr = ''
    let settled = false
    let exit: number | null | undefined
    let socket: WebSocket | null = null

    const settle = (run: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    const giveUp = (run: () => void) => {
      settle(() => {
        socket?.terminate()
        child.kill('SIGKILL')
        run()
      })
    }
    const timer = setTimeout(() => {
      giveUp(() =>
        reject(
          new ConnectError(
            'unreachable',
            phrase('ssh.timeout', { seconds: Math.round(PROXY_TIMEOUT_MS / 1000) }),
            true,
            tailOf(stderr),
          ),
        ),
      )
    }, PROXY_TIMEOUT_MS)
    signal.addEventListener(
      'abort',
      () => giveUp(() => reject(new ConnectError('unreachable', phrase('connect.cancelled')))),
      { once: true },
    )

    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    child.stdin.on('error', () => {})
    child.on('error', (error) => settle(() => reject(spawnFailure(error))))

    // 标记那一行之前的输出是 shell 启动时的杂音，丢掉；那一行之后的原样交给 WebSocket。
    // 那一行是“<标记> <接的是哪一种>”
    const clean = new PassThrough()
    let head = Buffer.alloc(0)
    let marked = false
    const mark = Buffer.from(script.marker)
    child.stdout.on('data', (chunk: Buffer) => {
      if (marked) {
        clean.write(chunk)
        return
      }
      head = Buffer.concat([head, chunk])
      const at = head.indexOf(mark)
      const end = at < 0 ? -1 : head.indexOf(0x0a, at + mark.length)
      if (end < 0) {
        // 标记到了、那一行还没到齐：从标记起留着。标记还没到：杂音再多也只留够认出它的那一截
        if (at >= 0) head = head.subarray(at)
        else if (head.length > 1 << 20) head = head.subarray(head.length - mark.length)
        return
      }
      marked = true
      const word = head
        .subarray(at + mark.length, end)
        .toString()
        .trim()
      const rest = head.subarray(end + 1)
      head = Buffer.alloc(0)
      if (rest.length) clean.write(rest)
      upgrade(word === 'service' ? 'service' : 'codex')
    })
    child.stdout.on('end', () => clean.end())

    child.on('close', (code) => {
      exit = code
      // 握手之前就退了
      settle(() => {
        if (!marked && code === 255) return resolve({ ok: false, reason: sshFailure(stderr) })
        if (!marked && code === EXIT.notFound) return resolve({ ok: false, reason: notInstalled() })
        resolve({ ok: false, reason: null })
      })
    })

    /** 断开的时候给人看的原因。ssh 自己断的（255）和还不知道退出码的，都说成“连接断开了” */
    const dropReason = (): Text | null =>
      exit === undefined || exit === null || exit === 255
        ? phrase('connect.dropped')
        : phrase('ssh.failed', { code: exit })

    // 见到标记之后才开始握手：这时对面已经换成了代理子命令，之后发过去的字节都归它。
    // 提前发的话，会被还在读脚本的 sh 当成脚本吃掉。
    const upgrade = (peer: Peer) => {
      const stream = Duplex.from({ readable: clean, writable: child.stdin })
      // 地址只是个占位：真正的连接就是这条 ssh 的标准输入输出
      socket = new WebSocket('ws://remote.invalid/', {
        createConnection: () => stream as never,
        perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD,
      })
      const opened = socket
      opened.once('open', () => {
        settle(() => {
          opened.removeAllListeners('error')
          resolve({
            ok: true,
            peer,
            transport: wrapSocket(opened, {
              heartbeat: HEARTBEAT,
              reason: dropReason,
              // ssh 进程没了，这条连接就是断了，进程退出本身就算数，不只靠 WebSocket 自己发现。
              // 实测有走不完的时候：ssh 的退出先于它标准输出的结束被处理时，它的标准输入已经随进程销毁，
              // WebSocket 随后去结束这条流，等一个永远不来的“写完了”，就此停在“正在关闭”上，
              // 既不报关闭也不报错，设备一直显示连着
              lost: (report) => {
                const late = () => setTimeout(report, EXIT_GRACE_MS).unref()
                if (child.exitCode !== null || child.signalCode !== null) late()
                else child.once('exit', late)
              },
              // 传输结束了，这条 ssh 也不要了。先让它自己收尾；卡死了不理人的就强行结束
              ended: () => {
                child.stdin.end()
                setTimeout(() => child.kill('SIGTERM'), 500).unref()
                setTimeout(() => child.kill('SIGKILL'), 3000).unref()
              },
            }),
          })
        })
      })
      // 握手没成：多半是对面的服务没在跑，代理子命令连不上就退了。这条 ssh 不要了，交给调用方接着走
      opened.once('error', () => giveUp(() => resolve({ ok: false, reason: null })))
    }

    child.stdin.write(script.text)
  })
}

export function sshOpener(target: RemoteTarget): TransportOpener {
  return async (signal, report) => {
    report?.(phrase('ssh.step.connect'))
    const first = await openProxy(target, signal, 'auto')
    if (first.ok) return first.transport
    if (first.reason) throw first.reason

    report?.(phrase('ssh.step.probe'))
    const found = await probe(target, signal)

    const service = found.peer === 'service'
    report?.(phrase(service ? 'ssh.step.startService' : 'ssh.step.start'))
    await startPeer(target, found.peer, signal)

    report?.(phrase('ssh.step.connect'))
    const second = await openProxy(target, signal, found.peer)
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

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

/**
 * 对面的设备服务这会儿在跑：顺便接上去问一句上面有哪些 harness，问完就断开。
 * 接不上、问不出来都是 null：只是看一眼，不为这个把添加设备拦下
 */
async function peek(target: RemoteTarget, signal: AbortSignalLike) {
  try {
    const opened = await openProxy(target, signal, 'service')
    return opened.ok ? await peekHarnesses(opened.transport, clock) : null
  } catch {
    return null
  }
}

/** 添加之前先看一眼。不启动任何东西；任何失败都收成结果交回去，不往外抛 */
export async function checkRemote(
  target: RemoteTarget,
  signal: AbortSignalLike,
): Promise<RemoteCheck> {
  try {
    const found = await probe(target, signal)
    if (found.peer === 'codex') {
      return { ok: true, peer: 'codex', version: found.version, system: found.system }
    }
    return {
      ok: true,
      peer: 'service',
      version: found.version,
      system: found.system,
      running: found.running,
      harnesses: found.running ? await peek(target, signal) : null,
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
