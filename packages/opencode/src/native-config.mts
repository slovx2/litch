import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyEdits,
  createScanner,
  type FormattingOptions,
  modify,
  type ParseError,
  parse,
  printParseErrorCode,
} from 'jsonc-parser'

// OpenCode 自己在磁盘上的几处文件：全局配置、凭据、用户级指令文件。位置照 OpenCode 1.18 的规矩算
//（@opencode-ai/core 的 global.ts：xdg-basedir 的 XDG_CONFIG_HOME、XDG_DATA_HOME，没设就是 ~/.config、~/.local/share）。
// 适配器拉起的 serve 继承同一份环境，所以这里算出来的就是 serve 读的那几个文件。
//
// 全局配置 OpenCode 依次读 config.json、opencode.json、opencode.jsonc 三个文件合在一起（后读的盖前面的），
// 自己改配置时写的是三个里头第一个存在的（opencode.jsonc 优先），都没有就新建 opencode.jsonc。这里照做。
// 写的时候只改要改的键：用 jsonc-parser 按路径改原文，注释、认不出的键、原来的排版都留着。

export const CONFIG_SCHEMA_URL = 'https://opencode.ai/config.json'
const CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc'] as const
const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' }

export interface OpencodePaths {
  home: string
  /** 全局配置目录（Global.Path.config） */
  configDir: string
  /** 数据目录（Global.Path.data），auth.json 在这里 */
  dataDir: string
  /** 用户级指令文件 AGENTS.md 所在的目录：OPENCODE_CONFIG_DIR 优先 */
  instructionsDir: string
  /** OpenCode 读不读 ~/.claude/CLAUDE.md（OPENCODE_DISABLE_CLAUDE_CODE[_PROMPT] 关掉） */
  claudeFallback: boolean
}

const truthy = (value: string | undefined) => value === 'true' || value === '1'

export function opencodePaths(env: NodeJS.ProcessEnv = process.env): OpencodePaths {
  // OpenCode 用 os.homedir()：POSIX 上就是 HOME；测试时它认 OPENCODE_TEST_HOME
  const home = env.OPENCODE_TEST_HOME || homedir()
  const configDir = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  const dataDir = join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')
  return {
    home,
    configDir,
    dataDir,
    instructionsDir: env.OPENCODE_CONFIG_DIR || configDir,
    claudeFallback: !(
      truthy(env.OPENCODE_DISABLE_CLAUDE_CODE) || truthy(env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT)
    ),
  }
}

export const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 先写旁边的临时文件再改名，写到一半断电也不会留下半个文件 */
export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.litch-${process.pid}-${Date.now()}`
  writeFileSync(temp, text, { mode: 0o600 })
  renameSync(temp, path)
}

/** JSONC 原文解析成值；有语法错误时报出第一处 */
export function parseJsonc(text: string, path: string): any {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  const first = errors[0]
  if (first)
    throw new Error(`${path} 第 ${first.offset} 个字符处 ${printParseErrorCode(first.error)}`)
  return value ?? {}
}

// jsonc-parser 的 SyntaxKind 是 const enum，开着 verbatimModuleSyntax 取不到，照它的定义写数
const LINE_COMMENT = 12
const BLOCK_COMMENT = 13
const EOF = 17

/** 原文里有没有注释 */
export function hasComments(text: string): boolean {
  const scanner = createScanner(text, false)
  for (let kind: number = scanner.scan(); kind !== EOF; kind = scanner.scan())
    if (kind === LINE_COMMENT || kind === BLOCK_COMMENT) return true
  return false
}

/**
 * 按路径改一处：value 为 undefined 是删掉这个键。first 为真时新加的键放在对象最前面
 *（OpenCode 的权限规则按书写顺序、后写的生效，“*” 要排在最前）。
 */
export function editJsonc(
  text: string,
  path: Array<string | number>,
  value: unknown,
  first = false,
): string {
  const edits = modify(text || '{}', path, value, {
    formattingOptions: FORMAT,
    ...(first ? { getInsertionIndex: () => 0 } : {}),
  })
  return applyEdits(text || '{}', edits)
}

export interface ConfigSnapshot {
  /** 改的时候写哪个文件 */
  target: string
  /** 三个文件里存在的，按 OpenCode 读的先后，带原文 */
  files: Array<{ path: string; text: string }>
  /** 合起来的值（不展开 {env:}、{file:}，原样） */
  merged: Record<string, any>
  /** 目标文件自己的值 */
  own: Record<string, any>
  /** 目标文件的原文；不存在是空串 */
  text: string
  version: string
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 和 OpenCode 的 mergeDeep 一样：对象逐层合，别的（含数组）整个替换 */
export function mergeDeep(base: Record<string, any>, over: Record<string, any>) {
  const out: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(over))
    out[key] = isRecord(value) && isRecord(out[key]) ? mergeDeep(out[key], value) : value
  return out
}

/** 读全局配置 */
export function readGlobalConfig(paths: OpencodePaths): ConfigSnapshot {
  const files = CONFIG_FILES.flatMap((name) => {
    const path = join(paths.configDir, name)
    const text = readText(path)
    return text === null ? [] : [{ path, text }]
  })
  const target =
    ['opencode.jsonc', 'opencode.json', 'config.json']
      .map((name) => join(paths.configDir, name))
      .find((path) => existsSync(path)) ?? join(paths.configDir, 'opencode.jsonc')
  let merged: Record<string, any> = {}
  let own: Record<string, any> = {}
  for (const file of files) {
    const value = parseJsonc(file.text, file.path)
    if (!isRecord(value)) continue
    merged = mergeDeep(merged, value)
    if (file.path === target) own = value
  }
  const text = files.find((file) => file.path === target)?.text ?? ''
  return {
    target,
    files,
    merged,
    own,
    text,
    version: sha(files.map((file) => `${file.path}\n${file.text}`).join('\n\u0000')),
  }
}

/** auth.json：OpenCode 存凭据的地方（键是 provider 号，值带 type：api、oauth、wellknown） */
export function authFile(paths: OpencodePaths): string {
  return join(paths.dataDir, 'auth.json')
}

export function readAuth(paths: OpencodePaths): { entries: Record<string, any>; text: string } {
  const text = readText(authFile(paths)) ?? ''
  if (!text.trim()) return { entries: {}, text }
  try {
    const value = JSON.parse(text)
    return { entries: isRecord(value) ? value : {}, text }
  } catch {
    return { entries: {}, text }
  }
}
