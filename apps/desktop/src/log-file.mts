// 桌面端自己的日志文件（主进程 main.jsonl、核心进程 core.jsonl）：一行一条 JSON，按大小轮转，按时长和个数清理。
// 规则和设备侧一样（单个 10MB、每份连旧的共 5 个、7 天没写的删，LITCH_LOG_* 三个变量可调），
// 实现另写一份：客户端和适配器只经协议说话，不共用代码。
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface LogLimits {
  /** 单个文件到这么大就换新的；0 表示不按大小换 */
  maxBytes: number
  /** 含正在写的那个，最多几个文件；至少 1 */
  keep: number
  /** 旧文件最后一次写入超过这么久就删；0 表示不按时长删 */
  maxAgeMs: number
}

export function logLimits(env: NodeJS.ProcessEnv = process.env): LogLimits {
  const number = (raw: string | undefined, fallback: number) => {
    const parsed = raw ? Number(raw) : Number.NaN
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  return {
    maxBytes: number(env.LITCH_LOG_MAX_BYTES, 10 * 1024 * 1024),
    keep: Math.max(1, Math.floor(number(env.LITCH_LOG_KEEP, 5))),
    maxAgeMs: number(env.LITCH_LOG_MAX_AGE_DAYS, 7) * 24 * 60 * 60 * 1000,
  }
}

/** 换下来：x → x.1，x.1 → x.2……超出个数的删掉 */
export function rotateLog(path: string, limits: LogLimits): void {
  const oldest = limits.keep - 1
  if (oldest < 1) {
    try {
      truncateSync(path, 0)
    } catch {}
    return
  }
  try {
    unlinkSync(`${path}.${oldest}`)
  } catch {}
  for (let n = oldest - 1; n >= 1; n -= 1) {
    try {
      renameSync(`${path}.${n}`, `${path}.${n + 1}`)
    } catch {}
  }
  try {
    renameSync(path, `${path}.1`)
  } catch {}
}

/** 清理这一份的旧文件：编号超出的、太久没写的都删；正在写的太久没写也删 */
export function pruneLogs(path: string, limits: LogLimits, now: number): void {
  const directory = dirname(path)
  const name = basename(path)
  const expired = (file: string) => {
    if (limits.maxAgeMs <= 0) return false
    try {
      return now - statSync(file).mtimeMs > limits.maxAgeMs
    } catch {
      return false
    }
  }
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    const file = join(directory, entry)
    if (entry === name) {
      if (expired(file)) {
        try {
          unlinkSync(file)
        } catch {}
      }
      continue
    }
    if (!entry.startsWith(`${name}.`)) continue
    const n = Number(entry.slice(name.length + 1))
    if (!Number.isInteger(n) || n < 1) continue
    if (n > limits.keep - 1 || expired(file)) {
      try {
        unlinkSync(file)
      } catch {}
    }
  }
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface DesktopLog {
  readonly path: string
  write(event: string, fields?: Record<string, unknown>, level?: LogLevel): void
  flush(): void
}

/**
 * 一份 JSONL 日志：同一轮事件循环里记的行攒起来，末尾一次写出去，进程退出时也写。
 * 写之前看大小，到了上限先换一个新文件。写不成就算了，日志不能耽误正事。
 */
export function createDesktopLog(
  path: string,
  options: { source: string; limits?: LogLimits; now?: () => number },
): DesktopLog {
  const limits = options.limits ?? logLimits()
  const now = options.now ?? Date.now
  let lines: string[] = []
  let scheduled = false
  let exiting = false
  let ready = false
  const flush = () => {
    scheduled = false
    if (lines.length === 0) return
    const pending = lines
    lines = []
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        pruneLogs(path, limits, now())
        ready = true
      }
      let size = 0
      try {
        size = statSync(path).size
      } catch {}
      let chunk = ''
      for (const line of pending) {
        if (limits.maxBytes > 0 && size >= limits.maxBytes) {
          if (chunk) appendFileSync(path, chunk, { mode: 0o600 })
          chunk = ''
          rotateLog(path, limits)
          pruneLogs(path, limits, now())
          size = 0
        }
        chunk += line
        size += Buffer.byteLength(line)
      }
      if (chunk) appendFileSync(path, chunk, { mode: 0o600 })
    } catch {
      ready = false
    }
  }
  process.once('exit', () => {
    exiting = true
    flush()
  })
  return {
    path,
    write(event, fields = {}, level = 'info') {
      let line: string
      try {
        line = `${JSON.stringify({
          ts: new Date(now()).toISOString(),
          level,
          src: options.source,
          pid: process.pid,
          event,
          ...fields,
        })}\n`
      } catch {
        return
      }
      lines.push(line)
      if (exiting) flush()
      else if (!scheduled) {
        scheduled = true
        setImmediate(flush)
      }
    },
    flush,
  }
}

/**
 * 把这个进程的 console.error、console.warn 也记一份进日志（原样还打到标准错误）。
 * 现有的 [update]、[core]、[browser] 这类一行一行的输出就都落了盘。外壳平时就用 console.error 打诊断行，
 * 不都是出错，所以记成 info
 */
export function teeConsole(log: DesktopLog): void {
  guardStdio()
  for (const [method, level] of [
    ['error', 'info'],
    ['warn', 'warn'],
  ] as const) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]) => {
      try {
        original(...args)
      } catch (error) {
        // 终端关了或父进程先退出，管道断了；控制台这一侧静默失败，日志文件照写
        if (!isBrokenPipe(error)) throw error
      } finally {
        const text = args
          .map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : String(arg)))
          .join(' ')
        log.write('log', { text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text }, level)
      }
    }
  }
}

/** 标准输出、标准错误的管道断了（对面已退出）时写它们会报的错 */
export function isBrokenPipe(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

/**
 * 管道断开时流会异步发 error 事件，没有监听者就成了未捕获异常、弹出错误框。
 * 断开类错误吞掉；别的错误在监听器里原样抛出，和没挂监听时一样是未捕获异常
 */
function guardStdio(): void {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.listeners('error').includes(rethrowUnlessBrokenPipe)) continue
    stream.on('error', rethrowUnlessBrokenPipe)
  }
}

function rethrowUnlessBrokenPipe(error: unknown): void {
  if (!isBrokenPipe(error)) throw error
}

/** 日志目录交给核心进程用的变量 */
export const DESKTOP_LOG_DIR = 'LITCH_DESKTOP_LOG_DIR'
