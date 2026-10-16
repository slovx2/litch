// 测试用的假进程：照协议原有的 process/* 和可重连终端的扩展（protocol/extensions/device-processes.json）应答。
// 进程不真的跑，输出由测试喂；设备留多少输出可以调小，好测“补不上的那一段”。
// 属于设备的进程跨连接留着；属于连接的进程和各条连接的挂接，断线时由测试调 dropped() 清掉。
import type { DeviceProcessInfo } from '../../protocol/src/index.mjs'
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from '../src/index.mjs'
import { type FakeServer, type Handler, RpcFailure } from './fake-server.mjs'

interface Proc {
  handle: string
  /** 属于设备，还是属于发起它的那条连接 */
  device: boolean
  command: string[]
  cwd: string
  env: Record<string, string>
  size: { rows: number; cols: number }
  tag: unknown
  startedAt: number
  running: boolean
  exit: { exitCode: number; exitedAt: number } | null
  /** 设备上留着的那一段 */
  kept: Uint8Array
  /** 到现在一共输出了多少字节 */
  total: number
  /** 现在这条连接挂没挂着 */
  attached: boolean
}

export interface FakeProcesses {
  handlers: Record<string, Handler>
  readonly procs: Map<string, Proc>
  /** 写进各个进程的输入，按到达的先后 */
  readonly writes: { handle: string; text: string }[]
  /** 同时能跑几个属于设备的进程 */
  limit: number
  /** 进程输出一段。挂着的连接收到，没挂着的只进设备的缓冲 */
  emit(handle: string, text: string): void
  /** 进程自己退出了 */
  exit(handle: string, code: number): void
  /** 连接断了：属于连接的进程结束，属于设备的解除挂接 */
  dropped(): void
  /** 设备服务重启了：属于设备的进程都没了 */
  restarted(): void
  /** 别的连接起了一个属于设备的进程 */
  startElsewhere(handle: string, tag: unknown): void
  /** 别的连接把一个进程结束并清掉了 */
  removeElsewhere(handle: string): void
  info(handle: string): DeviceProcessInfo
}

const fault = (reason: string, message: string, code = -32600, extra: object = {}) =>
  new RpcFailure(code, message, { litch: reason, ...extra })

/** peer：现在连着的那条连接，通知往它上面发。keep：设备给每个进程留多少字节的输出 */
export function fakeProcesses(peer: () => FakeServer, keep = 64): FakeProcesses {
  const procs = new Map<string, Proc>()
  const writes: { handle: string; text: string }[] = []
  let clock = 1_700_000_000

  const infoOf = (proc: Proc): DeviceProcessInfo => ({
    processHandle: proc.handle,
    command: proc.command,
    cwd: proc.cwd,
    tty: true,
    size: proc.size,
    startedAt: proc.startedAt,
    running: proc.running,
    exit: proc.exit,
    attached: proc.attached ? 1 : 0,
    tag: (proc.tag ?? null) as DeviceProcessInfo['tag'],
    retained: { from: proc.total - proc.kept.length, to: proc.total },
  })

  const changed = (proc: Proc, change: string, removed = false) =>
    peer().notify('litch/process/changed', {
      processHandle: proc.handle,
      change,
      process: removed ? null : infoOf(proc),
    })

  /** 属于设备的进程，没有就按扩展的说法报错 */
  const deviceProc = (params: unknown): Proc => {
    const { processHandle } = params as { processHandle: string }
    const proc = procs.get(processHandle)
    if (!proc?.device) throw fault('unknownProcess', `没有这个进程：${processHandle}`)
    return proc
  }

  /** 标准的写输入、改大小、结束落在谁身上：这条连接自己的进程，或者它挂着的设备进程 */
  const reachable = (params: unknown): Proc => {
    const { processHandle } = params as { processHandle: string }
    const proc = procs.get(processHandle)
    if (!proc || (proc.device && !proc.attached) || !proc.running) {
      throw new RpcFailure(-32600, `no active process for handle ${processHandle}`)
    }
    return proc
  }

  const frame = (proc: Proc, bytes: Uint8Array, offset: number, mark: object = {}) =>
    peer().notify('process/outputDelta', {
      processHandle: proc.handle,
      stream: 'stdout',
      deltaBase64: encodeBase64(bytes),
      capReached: false,
      ...(proc.device ? { litchDevice: { offset, ...mark } } : {}),
    })

  const finish = (proc: Proc, code: number) => {
    proc.running = false
    proc.exit = { exitCode: code, exitedAt: ++clock }
    if (!proc.device || proc.attached) {
      peer().notify('process/exited', {
        processHandle: proc.handle,
        exitCode: code,
        stdout: '',
        stdoutCapReached: false,
        stderr: '',
        stderrCapReached: false,
        ...(proc.device ? { litchDevice: { offset: proc.total } } : {}),
      })
    }
    if (proc.device) changed(proc, 'exited')
    else procs.delete(proc.handle)
  }

  const fake: FakeProcesses = {
    procs,
    writes,
    limit: 32,
    handlers: {
      'process/spawn': (params) => {
        const asked = params as {
          processHandle: string
          command: string[]
          cwd: string
          env?: Record<string, string>
          size?: { rows: number; cols: number }
          litchDevice?: { tag?: unknown } | null
        }
        if (procs.has(asked.processHandle)) {
          throw asked.litchDevice
            ? fault('processHandleInUse', '这个句柄已经有人用了')
            : new RpcFailure(-32600, 'duplicate active process handle')
        }
        const device = asked.litchDevice != null
        if (
          device &&
          [...procs.values()].filter((p) => p.device && p.running).length >= fake.limit
        ) {
          throw fault('processLimitReached', '到上限了', -32060, { limit: fake.limit })
        }
        const proc: Proc = {
          handle: asked.processHandle,
          device,
          command: asked.command,
          cwd: asked.cwd,
          env: asked.env ?? {},
          size: asked.size ?? { rows: 24, cols: 80 },
          tag: asked.litchDevice?.tag ?? null,
          startedAt: ++clock,
          running: true,
          exit: null,
          kept: new Uint8Array(0),
          total: 0,
          // 发起的那条连接自动挂着
          attached: device,
        }
        procs.set(proc.handle, proc)
        if (!device) return {}
        // 变更的通知排在应答后面
        void Promise.resolve().then(() => changed(proc, 'started'))
        return { litchDevice: infoOf(proc) }
      },
      'process/writeStdin': (params) => {
        const proc = reachable(params)
        const { deltaBase64 } = params as { deltaBase64?: string }
        writes.push({ handle: proc.handle, text: decodeUtf8(decodeBase64(deltaBase64 ?? '')) })
        return {}
      },
      'process/resizePty': (params) => {
        const proc = reachable(params)
        proc.size = (params as { size: { rows: number; cols: number } }).size
        if (proc.device) void Promise.resolve().then(() => changed(proc, 'updated'))
        return {}
      },
      'process/kill': (params) => {
        const proc = reachable(params)
        void Promise.resolve().then(() => finish(proc, 1))
        return {}
      },
      'litch/process/list': () => ({
        data: [...procs.values()].filter((proc) => proc.device).map(infoOf),
      }),
      'litch/process/attach': (params) => {
        const proc = deviceProc(params)
        const { fromOffset } = params as { fromOffset?: number | null }
        const from = fromOffset ?? 0
        if (from > proc.total) throw new RpcFailure(-32602, 'fromOffset 比已有的输出还靠后')
        const keptFrom = proc.total - proc.kept.length
        const replayFrom = Math.max(from, keptFrom)
        const replay = proc.kept.subarray(replayFrom - keptFrom)
        proc.attached = true
        const replayTo = proc.total
        // 应答先到，留着的输出随后发来
        void Promise.resolve().then(() => {
          if (replay.length > 0) frame(proc, replay, replayFrom, { replay: true })
          if (!proc.running && proc.exit) {
            peer().notify('process/exited', {
              processHandle: proc.handle,
              exitCode: proc.exit.exitCode,
              stdout: '',
              stdoutCapReached: false,
              stderr: '',
              stderrCapReached: false,
              litchDevice: { offset: proc.total },
            })
          }
        })
        return { process: infoOf(proc), replayFrom, replayTo, missedBytes: replayFrom - from }
      },
      'litch/process/detach': (params) => {
        const { processHandle } = params as { processHandle: string }
        const proc = procs.get(processHandle)
        if (proc?.device) proc.attached = false
        return {}
      },
      'litch/process/kill': (params) => {
        const proc = deviceProc(params)
        const { remove } = params as { remove?: boolean }
        void Promise.resolve().then(() => {
          if (proc.running) finish(proc, 1)
          if (remove) {
            procs.delete(proc.handle)
            changed(proc, 'removed', true)
          }
        })
        return {}
      },
      'litch/process/remove': (params) => {
        const proc = deviceProc(params)
        if (proc.running) throw fault('processRunning', '进程还在跑')
        procs.delete(proc.handle)
        void Promise.resolve().then(() => changed(proc, 'removed', true))
        return {}
      },
    },

    emit(handle, text) {
      const proc = procs.get(handle)
      if (!proc) throw new Error(`没有这个进程：${handle}`)
      const bytes = encodeUtf8(text)
      const offset = proc.total
      proc.total += bytes.length
      const joined = new Uint8Array(proc.kept.length + bytes.length)
      joined.set(proc.kept)
      joined.set(bytes, proc.kept.length)
      proc.kept = proc.device ? joined.subarray(Math.max(0, joined.length - keep)) : joined
      if (!proc.device || proc.attached) frame(proc, bytes, offset)
    },

    exit(handle, code) {
      const proc = procs.get(handle)
      if (proc) finish(proc, code)
    },

    dropped() {
      for (const proc of [...procs.values()]) {
        if (proc.device) proc.attached = false
        else procs.delete(proc.handle)
      }
    },

    restarted() {
      procs.clear()
    },

    startElsewhere(handle, tag) {
      const proc: Proc = {
        handle,
        device: true,
        command: ['/bin/sh'],
        cwd: '/',
        env: {},
        size: { rows: 30, cols: 100 },
        tag,
        startedAt: ++clock,
        running: true,
        exit: null,
        kept: new Uint8Array(0),
        total: 0,
        attached: false,
      }
      procs.set(handle, proc)
      changed(proc, 'started')
    },

    removeElsewhere(handle) {
      const proc = procs.get(handle)
      if (!proc) return
      procs.delete(handle)
      changed(proc, 'removed', true)
    },

    info(handle) {
      const proc = procs.get(handle)
      if (!proc) throw new Error(`没有这个进程：${handle}`)
      return infoOf(proc)
    },
  }
  return fake
}
