// 设备侧 Node 进程共用的日志文件：一行一条 JSON，按大小轮转，按时长和个数清理。
// 上限由三个环境变量调（LITCH_LOG_MAX_BYTES、LITCH_LOG_KEEP、LITCH_LOG_MAX_AGE_DAYS），
// 规则和 Go 那一层（cmd/codex-harness-adapter/logs.go）一致。只用 Node 自带的模块：设备进程也引用这里。
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface LogLimits {
  /** 单个文件到这么大就换新的；0 表示不按大小换 */
  maxBytes: number
  /** 每个来源最多几个文件，含正在写的那个；至少 1 */
  keep: number
  /** 旧文件最后一次写入超过这么久就删；0 表示不按时长删 */
  maxAgeMs: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function logLimits(env: NodeJS.ProcessEnv = process.env): LogLimits {
  return {
    maxBytes: numberFrom(env.LITCH_LOG_MAX_BYTES, 10 * 1024 * 1024),
    keep: Math.max(1, Math.floor(numberFrom(env.LITCH_LOG_KEEP, 5))),
    maxAgeMs: numberFrom(env.LITCH_LOG_MAX_AGE_DAYS, 7) * DAY_MS,
  }
}

function numberFrom(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** 日志目录：命令行那一层经这个变量交过来 */
export const LOG_DIR_VARIABLE = 'LITCH_LOG_DIR'

let takenLogDir: string | null | undefined

/**
 * 取命令行交来的日志目录，并把变量从自己的环境里拿掉：这个进程再起的进程（CLI、会话里跑的命令、终端）
 * 看不到它，会话里跑的测试就写不进真实的状态目录。没给就是 null，调用方不写日志。
 * 同一个进程里取第二次拿到的还是第一次的结果。
 */
export function takeLogDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (takenLogDir !== undefined) return takenLogDir
  const value = env[LOG_DIR_VARIABLE]
  delete env[LOG_DIR_VARIABLE]
  takenLogDir = value ? resolve(value) : null
  return takenLogDir
}

/** 测试用：忘掉取过的目录 */
export function resetTakenLogDir(): void {
  takenLogDir = undefined
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/** 第 n 个旧文件的名字（n 从 1 起，越大越旧） */
export const rotatedName = (path: string, n: number) => `${path}.${n}`

/**
 * 把正在写的文件换下来：x → x.1，原来的 x.1 → x.2……超出个数的删掉。之后写的人会建一个新的 x。
 * 拿着文件句柄一直写的那种（别的进程的标准错误）不能这样换，见 Go 那一层的复制再截断。
 */
export function rotateLog(path: string, limits: LogLimits): void {
  const oldest = limits.keep - 1
  if (oldest < 1) {
    // 只留一个文件：没有旧文件可放，清空重来
    try {
      truncateSync(path, 0)
    } catch {}
    return
  }
  try {
    unlinkSync(rotatedName(path, oldest))
  } catch {}
  for (let n = oldest - 1; n >= 1; n -= 1) {
    try {
      renameSync(rotatedName(path, n), rotatedName(path, n + 1))
    } catch {}
  }
  try {
    renameSync(path, rotatedName(path, 1))
  } catch {}
}

/**
 * 按个数和时长清理这个来源的旧文件：编号超出的、最后一次写入早于期限的都删。
 * 正在写的文件太久没写过，也换下来删掉（那就是一份过期的日志）。
 */
export function pruneLogs(path: string, limits: LogLimits, now: number = Date.now()): void {
  const directory = dirname(path)
  const name = basename(path)
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  const expired = (file: string) => {
    if (limits.maxAgeMs <= 0) return false
    try {
      return now - statSync(file).mtimeMs > limits.maxAgeMs
    } catch {
      return false
    }
  }
  if (entries.includes(name) && expired(path)) {
    try {
      unlinkSync(path)
    } catch {}
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${name}.`)) continue
    const n = Number(entry.slice(name.length + 1))
    if (!Number.isInteger(n) || n < 1) continue
    const file = join(directory, entry)
    if (n > limits.keep - 1 || expired(file)) {
      try {
        unlinkSync(file)
      } catch {}
    }
  }
}

export interface JsonlLogOptions {
  /** 每一行都带的来源名 */
  source: string
  limits?: LogLimits
  now?: () => number
}

export type LogLevel = 'info' | 'warn' | 'error'

export interface JsonlLog {
  readonly path: string
  write(event: string, fields?: Record<string, unknown>, level?: LogLevel): void
  /** 把攒着的行写出去（进程退出前、测试里） */
  flush(): void
}

/**
 * 一份 JSONL 日志。不当场写文件：同一轮事件循环里记的行攒起来，末尾一次写出去；进程退出时也写。
 * 写之前看大小，到了上限先换一个新文件。写不成（磁盘满、没权限）就算了，日志不能耽误正事。
 */
export function createJsonlLog(path: string, options: JsonlLogOptions): JsonlLog {
  const limits = options.limits ?? logLimits()
  const now = options.now ?? Date.now
  let lines: string[] = []
  let scheduled = false
  let exiting = false
  let readyDir = false
  const flush = () => {
    scheduled = false
    if (lines.length === 0) return
    const pending = lines
    lines = []
    try {
      if (!readyDir) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        readyDir = true
        pruneLogs(path, limits, now())
      }
      // 每批现量：同一个文件可能还有别的进程在写（检测、代理子命令）
      let size = Math.max(0, sizeOf(path))
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
      // 目录被删了之类：下一批重新建目录
      readyDir = false
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

const ID_KEY = /(^|[a-z])Id$/
const ID_LIMIT = 100
const SETTING_LIMIT = 300
const ERROR_LIMIT = 500
/**
 * 设置类的参数：模型、推理强度、权限档位、工作目录。值是字符串、数字、真假才记；
 * 是对象的（比如 sandboxPolicy、collaborationMode）只记它的 type 或 mode，别的字段不看。
 */
const SETTING_KEYS = new Set([
  'model',
  'modelProvider',
  'effort',
  'reasoningEffort',
  'serviceTier',
  'approvalPolicy',
  'approvalsReviewer',
  'sandbox',
  'sandboxPolicy',
  'permissions',
  'permissionMode',
  'collaborationMode',
  'cwd',
])

/**
 * 从参数里挑出能记的字段：标识（名字以 Id 结尾的、harness）和设置（SETTING_KEYS）。只看第一层；
 * 正文、文件内容、命令、密钥这些字段名不在里面，不记。
 */
export function paramFields(params: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return result
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (key === 'harness' || ID_KEY.test(key)) {
      if (typeof value === 'string') result[key] = value.slice(0, ID_LIMIT)
      else if (typeof value === 'number') result[key] = value
    } else if (SETTING_KEYS.has(key)) {
      const setting = settingValue(value)
      if (setting !== undefined) result[key] = setting
    }
  }
  return result
}

function settingValue(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'string') return value.slice(0, SETTING_LIMIT)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { type, mode } = value as { type?: unknown; mode?: unknown }
  const kind = typeof type === 'string' ? type : typeof mode === 'string' ? mode : undefined
  return kind?.slice(0, ID_LIMIT)
}

/** 错误原文：截到 500 字 */
export function errorText(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : error !== null && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}…` : text
}
