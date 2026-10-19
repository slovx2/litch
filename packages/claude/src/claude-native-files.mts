// Claude Code 自己的用户级文件：~/.claude/settings.json、~/.claude.json、~/.claude/CLAUDE.md。
// 位置跟随 CLAUDE_CONFIG_DIR（和 CLI、mcp.mts 的取法一致）。读写都按整份 JSON 读进来、只改要改的键、
// 认不出的部分原样保留；写入先写临时文件再改名，保留原来的权限；路径本身是软链时写到它指向的文件
// （指令文件统一模式下 CLAUDE.md 是软链，不能把软链换成普通文件）。
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), 'settings.json')
}

// 用户级 MCP 在 ~/.claude.json 顶层；设了 CLAUDE_CONFIG_DIR 时在那个目录里（同 mcp.mts 的 readMcpConfig）
export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json')
}

export function claudeInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), 'CLAUDE.md')
}

// 管理员下发的设置（managed-settings.json），优先级最高，里面写了的键用户层改不动
export function claudeManagedSettingsPath(): string {
  if (process.platform === 'darwin')
    return '/Library/Application Support/ClaudeCode/managed-settings.json'
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** 读一个文本文件；不存在是 null */
export function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export class NativeFileError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(message)
    this.path = path
  }
}

/** 读一个 JSON 对象文件。不存在是空对象；内容不是对象时抛错，不能当成空的覆盖掉 */
export function readJsonObject(path: string): {
  value: Record<string, unknown>
  raw: string | null
} {
  const raw = readTextFile(path)
  if (raw === null || raw.trim() === '') return { value: {}, raw }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new NativeFileError(path, `${path} 不是有效的 JSON，先手动修好再改`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new NativeFileError(path, `${path} 的内容不是 JSON 对象`)
  return { value: parsed as Record<string, unknown>, raw }
}

// 软链写到它指向的文件；悬空的软链解析不了，退回写原路径（软链被换成普通文件）
function writeTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path
  } catch {
    return path
  }
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** 原子写入一个文本文件：同目录的临时文件写完改名过去，保留原来的权限（新文件按 mode） */
export function writeTextFileAtomic(path: string, content: string, mode = 0o644): void {
  const target = writeTarget(path)
  let keepMode = mode
  try {
    keepMode = statSync(target).mode & 0o777
  } catch {}
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, 'wx', keepMode)
    writeFileSync(descriptor, content)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, target)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
}

export function writeJsonObject(path: string, value: Record<string, unknown>, mode = 0o644): void {
  writeTextFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, mode)
}

/**
 * path 本身是软链时它指向哪里：照软链里写的、按它所在的目录解析成绝对路径，不再往下解析一层
 * （和统一模式给的 sourcePath 对得上）。不是软链是 null
 */
export function symlinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
  } catch {
    return null
  }
  try {
    return resolve(dirname(path), readlinkSync(path))
  } catch {
    return null
  }
}

// ---------- 键路径 ----------

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/**
 * 点分的键路径，段里有点或 @ 之类的用双引号括起来：`enabledPlugins."fmt@tools"`。
 * 返回 null 表示格式不对。
 */
export function parseKeyPath(key: string): string[] | null {
  const segments: string[] = []
  let offset = 0
  while (offset < key.length) {
    const match = /^(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+)/.exec(key.slice(offset))
    if (!match) return null
    const token = match[0]
    let segment: string
    try {
      segment = token.startsWith('"') ? JSON.parse(token) : token
    } catch {
      return null
    }
    if (!segment || FORBIDDEN_KEYS.has(segment)) return null
    segments.push(segment)
    offset += token.length
    if (offset === key.length) break
    if (key[offset++] !== '.' || offset === key.length) return null
  }
  return segments.length ? segments : null
}

export function quoteKeySegment(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function getAtPath(root: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

/** 设一个键；value 为 undefined 时删掉它，父对象删空了也一并删掉。父键不是对象时换成对象 */
export function setAtPath(root: Record<string, unknown>, segments: string[], value: unknown): void {
  const parents: Array<[Record<string, unknown>, string]> = []
  let target = root
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(target[segment])) {
      if (value === undefined) return
      target[segment] = {}
    }
    parents.push([target, segment])
    target = target[segment] as Record<string, unknown>
  }
  const last = segments.at(-1)!
  if (value === undefined) {
    delete target[last]
    for (const [parent, segment] of parents.reverse()) {
      const child = parent[segment]
      if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[segment]
      else break
    }
  } else target[last] = value
}
