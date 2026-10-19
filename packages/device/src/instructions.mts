// 用户级指令文件（AGENTS.md、CLAUDE.md）：读写一份，以及统一模式（litch/device/instructions/unify|separate）。
// 都是设备上的文件操作，设备进程自己做。
//
// 统一模式：一份正文写进 source（真文件），其余各份改成指向它的软链，之后在哪个 harness 里改都是同一份。
//   - 已有的文件先备份再换：备份放在原文件旁边，名字是 `<原名>.litch-backup-<本地时间 YYYYMMDD-HHMMSS>`
//     （同一秒里撞名再加 -1、-2……）。原来就是指向 source 的软链不用备份；原来是指向别处的软链，备份的是那个链接本身。
//   - 父目录不存在的跳过（那个 harness 多半没装），不替它建目录。
//   - 建软链失败（Windows 上没有创建符号链接的权限）就写一份副本，结果里标 copied。
//   - 只认名字是 AGENTS.md、CLAUDE.md 的文件：这是给指令文件用的，不当通用的“改成软链”接口。
// 退出统一模式：指向 source 的软链换成 source 当前内容的副本；不是指向它的不动。
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import {
  type DeviceInstructionsLinkResult,
  type DeviceInstructionsSeparateResponse,
  type DeviceInstructionsUnifyResponse,
  HARNESS_CONFIG_METHOD,
  type HarnessInstructionsInfo,
} from '../../protocol/src/harness-config.mjs'
import { HarnessConfigError, text } from './harness-config.mjs'
import { isObject } from './wire.mjs'

const FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md'])

/** 设备进程自己处理的方法回的错误里，harness 填这个（这两个方法不属于哪一个 harness） */
const DEVICE = ''

export const hashOf = (content: string): string =>
  `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`

const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

/** 软链指向哪里（解析成绝对路径，不管目标在不在）。不是软链是 null */
async function linkTargetOf(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isSymbolicLink()) return null
    return resolve(dirname(path), await readlink(path))
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

/** 读一个指令文件。overriddenBy 由调用方给（只有 Codex 有 AGENTS.override.md） */
export async function readInstructions(
  path: string,
  overriddenBy: string | null = null,
): Promise<HarnessInstructionsInfo> {
  const linkTarget = await linkTargetOf(path)
  let content = ''
  let exists = true
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (!missing(error)) throw error
    exists = false
  }
  return {
    path,
    fileName: basename(path),
    exists,
    content,
    hash: exists ? hashOf(content) : '',
    linkTarget,
    overriddenBy,
  }
}

/**
 * 整个写进去。是软链的写到它指向的文件里（统一模式下改的就是那一份）；不是的先写临时文件再换名，
 * 写到一半不会留下半截的文件。父目录没有就建。
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  const linked = await linkTargetOf(path)
  // 链套链的解到最后一层；指向的文件还不在（断了的链接）就写到它指向的地方
  const target = linked === null ? path : await realpath(path).catch(() => linked)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.litch-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** 写指令文件，带 expectedHash（读到时的哈希，不存在时是空串）；对不上回 versionConflict */
export async function writeInstructions(
  harness: string,
  path: string,
  content: string,
  expectedHash: unknown,
): Promise<{ hash: string }> {
  if (typeof content !== 'string' || typeof expectedHash !== 'string')
    throw new HarnessConfigError(
      'invalidValue',
      harness,
      text('content 和 expectedHash 都要是字符串', 'content and expectedHash must be strings'),
    )
  const current = await readInstructions(path)
  if (current.hash !== expectedHash)
    throw new HarnessConfigError(
      'versionConflict',
      harness,
      text(
        '指令文件在读过之后被改过了，请重读再改',
        'The instructions file changed since it was read',
      ),
    )
  await writeTextFile(path, content)
  return { hash: hashOf(content) }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** 原文件旁边一个没被占用的备份名 */
function backupPath(path: string, now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const base = `${path}.litch-backup-${stamp}`
  let candidate = base
  for (let serial = 1; existsSync(candidate); serial++) candidate = `${base}-${serial}`
  return candidate
}

function invalid(zh: string, en: string): HarnessConfigError {
  return new HarnessConfigError('invalidValue', DEVICE, text(zh, en))
}

/** 参数里的一个路径：绝对路径，文件名是 AGENTS.md 或 CLAUDE.md */
function instructionsPath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAbsolute(value))
    throw invalid(`${field} 要是绝对路径`, `${field} must be an absolute path`)
  if (!FILE_NAMES.has(basename(value)))
    throw invalid(
      `${field} 的文件名要是 AGENTS.md 或 CLAUDE.md：${value}`,
      `${field} must name an AGENTS.md or CLAUDE.md file: ${value}`,
    )
  return resolve(value)
}

/** linkPaths：去掉重复的和 source 自己 */
function linkPaths(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) throw invalid('linkPaths 要是数组', 'linkPaths must be an array')
  const paths = value.map((item, index) => instructionsPath(item, `linkPaths[${index}]`))
  return [...new Set(paths)].filter((path) => path !== source)
}

/** 父目录在不在（是不是目录） */
async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

/** 建一个指向 source 的软链；建不了（Windows 上没有权限）写一份副本 */
async function linkOrCopy(source: string, path: string, content: string) {
  try {
    await symlink(source, path, 'file')
    return 'linked' as const
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP' && code !== 'EINVAL')
      throw error
    await writeFile(path, content, 'utf8')
    return 'copied' as const
  }
}

async function unifyOne(
  source: string,
  path: string,
  content: string,
  now: Date,
): Promise<DeviceInstructionsLinkResult> {
  if (!(await directoryExists(dirname(path)))) return { path, outcome: 'skipped', backup: null }
  const target = await linkTargetOf(path)
  if (target === source) return { path, outcome: 'linked', backup: null }
  let backup: string | null = null
  try {
    const info = await lstat(path)
    if (info.isDirectory())
      throw invalid(`${path} 是一个目录，不能换成软链`, `${path} is a directory`)
    backup = backupPath(path, now)
    await rename(path, backup)
  } catch (error) {
    if (!missing(error)) throw error
  }
  return { path, outcome: await linkOrCopy(source, path, content), backup }
}

/** litch/device/instructions/unify */
export async function unifyInstructions(params: unknown): Promise<DeviceInstructionsUnifyResponse> {
  const fields = isObject(params) ? params : {}
  const source = instructionsPath(fields.sourcePath, 'sourcePath')
  if (typeof fields.content !== 'string')
    throw invalid('content 要是字符串', 'content must be a string')
  const content = fields.content
  const paths = linkPaths(fields.linkPaths, source)
  // source 要是真文件：它自己原来是软链（换过一次 source）的话，写的时候换名会把链接换成文件
  if ((await linkTargetOf(source)) !== null) await rm(source)
  await writeTextFile(source, content)
  const now = new Date()
  const results: DeviceInstructionsLinkResult[] = []
  // 一个一个来：备份名要看已有的文件，同时做会撞
  for (const path of paths) results.push(await unifyOne(source, path, content, now))
  return { results }
}

/** litch/device/instructions/separate */
export async function separateInstructions(
  params: unknown,
): Promise<DeviceInstructionsSeparateResponse> {
  const fields = isObject(params) ? params : {}
  const source = instructionsPath(fields.sourcePath, 'sourcePath')
  const paths = linkPaths(fields.linkPaths, source)
  let content: string | null = null
  const separated: string[] = []
  for (const path of paths) {
    if ((await linkTargetOf(path)) !== source) continue
    content ??= await readFile(source, 'utf8').catch((error) => {
      if (missing(error)) return ''
      throw error
    })
    await rm(path)
    await writeFile(path, content, 'utf8')
    separated.push(path)
  }
  return { separated }
}

/** 设备进程自己处理的这两个方法 */
export function instructionsCall(method: string, params: unknown): Promise<unknown> {
  if (method === HARNESS_CONFIG_METHOD.instructionsUnify) return unifyInstructions(params)
  return separateInstructions(params)
}
