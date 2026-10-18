// 在一台机器上起一个进程（协议原有的 process/spawn，流式的两路输出加可写的标准输入）。
// exec 的命令和执行器自己的小脚本（解真实路径、取大小、列目录、分块读写）都走这里。
//
// 一律用流式：不流式时对面把输出当 UTF-8 文字放进 process/exited，二进制会被弄坏；
// 输出上限也不交给对面（outputBytesCap: null）：对面到上限就不读了，进程会卡在写上。上限这里自己管。
// 这样起的进程属于这条连接，连接一断对面就把它结束了；连接断了的那一刻这里收不到退出的通知，
// 所以每个进程都有一个兜底的期限（timeoutMs 加一小段），到点还没有消息就当它丢了。
import type { AbortSignalLike, Clock } from '../../channel/protocol.mjs'
import { RpcAbortError, RpcError } from '../../connection/rpc.mjs'
import { decodeBase64, encodeBase64 } from '../../text/bytes.mjs'
import type { MachineTarget } from './types.mjs'

export interface RunOptions {
  cwd: string
  /** 标准输入留着能写。不留的话起来就关掉 */
  stdin: boolean
  /** 到点对面结束它（退出码 124）。null 是不限 */
  timeoutMs: number | null
  /** 每来一段输出 */
  onOutput?(stream: 'stdout' | 'stderr', bytes: Uint8Array): void
  /** 攒下标准输出，最多这么多字节；超了就结束进程，结果里 overflow 为真。不给就不攒 */
  collect?: number
  /** 攒下标准错误，最多这么多字节（多的不要，不结束进程）。缺省 16 KB */
  collectErr?: number
  env?: Record<string, string>
}

export interface RunExit {
  /** 进程的退出码。kind 不是 exited 时没有意义 */
  exitCode: number
  /** exited 正常收到了退出；lost 是连接断了或者到点没消息；killed 是这里结束的 */
  kind: 'exited' | 'lost' | 'killed'
  stdout: Uint8Array
  stderr: Uint8Array
  /** 标准输出超了 collect */
  overflow: boolean
}

export interface Running {
  handle: string
  done: Promise<RunExit>
  /** 写标准输入；close 为真时写完关掉 */
  write(bytes: Uint8Array, close?: boolean): Promise<void>
  kill(): void
}

/** 进程该结束了之后再等这么久，还没有 process/exited 就当它丢了 */
const GRACE_MS = 10_000
/** 起进程的请求等多久 */
const SPAWN_TIMEOUT_MS = 20_000
/** 不限时的进程隔这么久向对面问一声“还在不在”（写一个空的标准输入） */
const PROBE_MS = 60_000

export interface Runner {
  run(target: MachineTarget, command: readonly string[], options: RunOptions): Promise<Running>
}

export function createRunner(clock: Clock, random: () => number): Runner {
  const tag = Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')
  let seq = 0

  return {
    async run(target, command, options) {
      const handle = `litch-machine-${tag}-${++seq}`
      const out: Uint8Array[] = []
      const err: Uint8Array[] = []
      let outBytes = 0
      let errBytes = 0
      const errCap = options.collectErr ?? 16 * 1024
      let overflow = false
      let settled = false
      let killed = false
      let resolveDone: (exit: RunExit) => void = () => {}
      const done = new Promise<RunExit>((resolve) => {
        resolveDone = resolve
      })
      const stops: (() => void)[] = []
      const finish = (kind: RunExit['kind'], exitCode: number) => {
        if (settled) return
        settled = true
        for (const stop of stops) stop()
        resolveDone({
          exitCode,
          kind: killed && kind !== 'exited' ? 'killed' : kind,
          stdout: join(out, outBytes),
          stderr: join(err, errBytes),
          overflow,
        })
      }
      const kill = () => {
        if (settled) return
        killed = true
        target.request('process/kill', { processHandle: handle }).catch(() => {
          // 已经结束了、或者连接断了：都不用管
        })
      }

      stops.push(
        target.onProcessNotification((method, params) => {
          const raw = params as { processHandle?: unknown } | null
          if (raw?.processHandle !== handle) return false
          if (method === 'process/outputDelta') {
            const delta = params as { stream?: unknown; deltaBase64?: unknown }
            const bytes = decodeBase64(
              typeof delta.deltaBase64 === 'string' ? delta.deltaBase64 : '',
            )
            const stream = delta.stream === 'stderr' ? 'stderr' : 'stdout'
            if (stream === 'stdout' && options.collect !== undefined) {
              if (outBytes + bytes.length > options.collect) {
                overflow = true
                kill()
              } else {
                out.push(bytes)
                outBytes += bytes.length
              }
            }
            if (stream === 'stderr' && errBytes < errCap) {
              const keep = bytes.subarray(0, errCap - errBytes)
              err.push(keep)
              errBytes += keep.length
            }
            options.onOutput?.(stream, bytes)
            return true
          }
          if (method === 'process/exited') {
            const exited = params as { exitCode?: unknown }
            finish('exited', typeof exited.exitCode === 'number' ? exited.exitCode : 1)
            return true
          }
          return false
        }),
      )

      // 兜底：限时的到点加一段；不限时的隔一阵问一声，对面说不认识这个句柄就当它丢了
      if (options.timeoutMs != null) {
        stops.push(clock.setTimer(() => finish('lost', 1), options.timeoutMs + GRACE_MS))
      } else {
        const probe = () => {
          if (settled) return
          target
            .request('process/writeStdin', { processHandle: handle, deltaBase64: '' })
            .then(() => schedule())
            .catch((error: unknown) => {
              // 只认两种“不在了”：连接断了、对面说没有这个句柄。别的（一时慢了超时之类）隔一阵再问
              const gone =
                (error instanceof RpcAbortError && error.reason === 'closed') ||
                (error instanceof RpcError && /no active process/i.test(error.message))
              if (gone) finish('lost', 1)
              else schedule()
            })
        }
        const schedule = () => {
          if (!settled) stops.push(clock.setTimer(probe, PROBE_MS))
        }
        schedule()
      }

      try {
        await target.request(
          'process/spawn',
          {
            command: [...command],
            processHandle: handle,
            cwd: options.cwd,
            streamStdin: true,
            streamStdoutStderr: true,
            outputBytesCap: null,
            timeoutMs: options.timeoutMs,
            env: options.env ?? null,
          },
          { timeoutMs: SPAWN_TIMEOUT_MS },
        )
      } catch (error) {
        settled = true
        for (const stop of stops) stop()
        throw error
      }
      if (!options.stdin) {
        target
          .request('process/writeStdin', { processHandle: handle, closeStdin: true })
          .catch(() => {
            // 进程已经结束了：不用管
          })
      }

      return {
        handle,
        done,
        async write(bytes, close = false) {
          if (settled) throw new RpcError(-32600, 'process has exited')
          await target.request('process/writeStdin', {
            processHandle: handle,
            deltaBase64: bytes.length ? encodeBase64(bytes) : null,
            closeStdin: close,
          })
        },
        kill,
      }
    },
  }
}

function join(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** 等一个进程结束，或者被中止（中止时结束它）。被中止抛 RpcAbortError */
export async function finished(running: Running, signal?: AbortSignalLike): Promise<RunExit> {
  if (!signal) return running.done
  if (signal.aborted) {
    running.kill()
    throw new RpcAbortError('cancelled', 'cancelled')
  }
  return new Promise<RunExit>((resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        running.kill()
        reject(new RpcAbortError('cancelled', 'cancelled'))
      },
      { once: true },
    )
    running.done.then(resolve, reject)
  })
}
