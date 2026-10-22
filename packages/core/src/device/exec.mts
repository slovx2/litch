// 在设备上跑一条命令，等它结束，拿回退出码和两路输出。差异面板拿它跑 git。
//
// 用的是协议里现成的 process/spawn（不带终端、不流式）：对面起进程，结束时发一条 process/exited，
// 里面带着攒下来的输出。哪种对面都是这一条路——
// - 设备服务的聚合面：设备进程自己起（聚合面不提供 command/exec，见 packages/device/src/routes.mts）；
// - 某个 harness 自己的入口：那个引擎的进程起；
// - 原生 codex：它自己起（这组方法在它那里是实验性接口，握手时声明了 experimentalApi 才有）。
// 这样起的进程属于这条连接：连接一断对面就把它结束了。
//
// 命令一律是参数的数组，原样交给对面去执行，不经过任何 shell。
import type { ClientRequestMethod, ClientRequests } from '../../../protocol/src/index.mjs'
import { type AbortSignalLike, ChannelError, type Clock } from '../channel/protocol.mjs'
import { RpcAbortError, type RpcRequestOptions } from '../connection/rpc.mjs'

export interface ExecHost {
  clock: Clock
  request<M extends ClientRequestMethod>(
    method: M,
    params: ClientRequests[M]['params'],
    options?: RpcRequestOptions,
  ): Promise<ClientRequests[M]['result']>
  /** 0 到 1 之间的随机数，起句柄用。不给就用 Math.random */
  random?(): number
}

export interface ExecOptions {
  /** 在哪个目录里跑：对面机器上的绝对路径 */
  cwd: string
  /** 另外给的环境变量，盖在对面进程自己的环境上 */
  env?: Record<string, string>
  /** 每一路输出最多要这么多字节，多了的不要（结果里 capped 为真） */
  capBytes: number
  /** 跑这么久还没完就结束它 */
  timeoutMs: number
  signal?: AbortSignalLike
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  /** 标准输出到了上限，后面的没要 */
  capped: boolean
}

export interface Exec {
  /**
   * 跑一条命令。起不来（对面没有这个程序、对面不会起进程）时抛的是对面的原样错误，由调用的一方去认；
   * 取消了、超时了、连接断了抛 RpcAbortError
   */
  run(command: readonly string[], options: ExecOptions): Promise<ExecResult>
  /** 是这里起的进程的通知就处理并返回 true；不是就返回 false，交给别处（终端） */
  notification(method: string, params: unknown): boolean
  /** 连接断了：还在等的都以断线结束 */
  offline(): void
}

/** 对面超时结束进程时给的退出码（适配器和 codex 都是这个数） */
const TIMEOUT_EXIT = 124
/** 进程该结束了之后再等这么久，还没有 process/exited 就不等了 */
const GRACE_MS = 5000
const SPAWN_TIMEOUT_MS = 15_000

interface Waiting {
  resolve(result: ExecResult): void
  reject(error: unknown): void
}

export function createExec(host: ExecHost): Exec {
  const waiting = new Map<string, Waiting>()
  const random = host.random ?? Math.random
  // 句柄在一条连接里不能和别的进程（终端）撞上：带一段随机的字
  const tag = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  let seq = 0

  return {
    run(command, options) {
      const handle = `litch-exec-${tag}-${++seq}`
      return new Promise<ExecResult>((resolve, reject) => {
        let over = false
        let stopTimer: (() => void) | null = null
        const finish = (settle: () => void) => {
          if (over) return
          over = true
          waiting.delete(handle)
          stopTimer?.()
          settle()
        }
        if (options.signal?.aborted) {
          reject(new RpcAbortError('cancelled', '已取消'))
          return
        }
        waiting.set(handle, {
          resolve: (result) => finish(() => resolve(result)),
          reject: (error) => finish(() => reject(error)),
        })
        const kill = () => {
          host.request('process/kill', { processHandle: handle }).catch(() => {
            // 已经结束了、或者连接断了：都不用管
          })
        }
        options.signal?.addEventListener(
          'abort',
          () => {
            if (over) return
            kill()
            finish(() => reject(new RpcAbortError('cancelled', '已取消')))
          },
          { once: true },
        )
        // 对面到点会自己结束它并照常发退出的通知；这里多等一会儿还没有，才当它丢了
        stopTimer = host.clock.setTimer(() => {
          if (over) return
          kill()
          finish(() => reject(new RpcAbortError('timeout', `命令超时：${command[0] ?? ''}`)))
        }, options.timeoutMs + GRACE_MS)
        host
          .request(
            'process/spawn',
            {
              command: [...command],
              processHandle: handle,
              cwd: options.cwd,
              env: options.env ?? null,
              outputBytesCap: options.capBytes,
              timeoutMs: options.timeoutMs,
            },
            { timeoutMs: SPAWN_TIMEOUT_MS },
          )
          .catch((error: unknown) => finish(() => reject(error)))
      }).then((result) => {
        // 这里跑的命令（git）自己不会用这个退出码：是它就是对面到点把进程结束了
        if (result.exitCode === TIMEOUT_EXIT) {
          throw new RpcAbortError('timeout', `命令超时：${command[0] ?? ''}`)
        }
        return result
      })
    },

    notification(method, params) {
      if (method !== 'process/exited' && method !== 'process/outputDelta') return false
      const handle = (params as { processHandle?: unknown } | null)?.processHandle
      if (typeof handle !== 'string') return false
      const entry = waiting.get(handle)
      if (!entry) return false
      // 不流式的进程不该有输出的增量；真来了也是我们的，收下不管
      if (method === 'process/outputDelta') return true
      const exited = params as ClientExit
      entry.resolve({
        exitCode: typeof exited.exitCode === 'number' ? exited.exitCode : 1,
        stdout: typeof exited.stdout === 'string' ? exited.stdout : '',
        stderr: typeof exited.stderr === 'string' ? exited.stderr : '',
        capped: exited.stdoutCapReached === true,
      })
      return true
    },

    offline() {
      for (const entry of [...waiting.values()]) {
        entry.reject(new RpcAbortError('closed', '连接已断开'))
      }
    },
  }
}

interface ClientExit {
  exitCode?: unknown
  stdout?: unknown
  stderr?: unknown
  stdoutCapReached?: unknown
}

/** 命令没跑成的那几种“不等了”换成通道上的错误 */
export function abortFailure(error: unknown): ChannelError | null {
  if (!(error instanceof RpcAbortError)) return null
  if (error.reason === 'cancelled') return new ChannelError('cancelled', error.message)
  if (error.reason === 'timeout') return new ChannelError('timeout', error.message)
  return new ChannelError('offline', error.message)
}
