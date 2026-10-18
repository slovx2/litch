// read_file、write_file、list_dir（08 号设计 2.4、3.3）。
// 先看路径（真实路径、种类、大小，桌面端这台连同禁止位置），挡住的直接回 blocked、不弹卡片；再审批；再动手。
// 读：小文件用 fs/readFile 整读再切；大文件只读要的那一段（脚本 tail | head），不把整个文件搬过来。
import { MACHINE_LIMITS } from '../../../../protocol/src/client-tools-machine.mjs'
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from '../../text/bytes.mjs'
import { extensionOf } from '../../text/paths.mjs'
import {
  ArgumentError,
  approved,
  askView,
  asObject,
  blockedMessage,
  done,
  errorText,
  failed,
  lookPath,
  type Outcome,
  optionalInt,
  optionalString,
  stringArg,
  type ToolKit,
  targetOf,
} from './common.mjs'
import { utf8CompleteLength, utf8LeadingContinuation } from './output.mjs'
import { findPattern, parseListed, runScript, scriptCommand, splitBytes } from './scripts.mjs'

/** 不超过这么大的整个读回来再切（省一次起进程） */
const WHOLE_READ_MAX = 1024 * 1024
/** 图片作为图片给模型，最大这么大（客户端工具结果里单张图的上限） */
export const IMAGE_MAX = 4 * 1024 * 1024
/** write_file 的内容最多这么大 */
const WRITE_MAX = 16 * 1024 * 1024
/** list_dir 的脚本输出最多收这么多，超了就不要了 */
const LIST_COLLECT = 4 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 一看扩展名就知道不是文字的（不读内容，只报大小和类型） */
const BINARY_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  xz: 'application/x-xz',
  bz2: 'application/x-bzip2',
  '7z': 'application/x-7z-compressed',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  dll: 'application/vnd.microsoft.portable-executable',
  so: 'application/x-sharedlib',
  dylib: 'application/x-mach-binary',
  o: 'application/x-object',
  a: 'application/x-archive',
  class: 'application/java-vm',
  jar: 'application/java-archive',
  wasm: 'application/wasm',
  sqlite: 'application/vnd.sqlite3',
  db: 'application/octet-stream',
  bin: 'application/octet-stream',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  heic: 'image/heic',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

/** 读出来的这段像不像文字：有 NUL，或者解不开的地方多，就当二进制 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true
  const tally = { replaced: 0 }
  decodeUtf8(bytes, tally)
  return tally.replaced > Math.max(4, bytes.length / 100)
}

const sizeText = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export async function readFileTool(kit: ToolKit, raw: unknown): Promise<Outcome> {
  let summary = ''
  try {
    const args = asObject(raw)
    const rawPath = stringArg(args, 'path')
    summary = rawPath
    const offset = optionalInt(args, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0
    const length =
      optionalInt(args, 'length', 1, MACHINE_LIMITS.readBytes) ?? MACHINE_LIMITS.readBytes
    const target = targetOf(kit.context, args.machine)
    const facts = await target.facts()
    const looked = await lookPath(kit, target, facts, rawPath)
    summary = looked.path
    if (looked.blocked) return failed('blocked', blockedMessage(looked), summary)
    const refused = await approved(
      kit,
      { class: 'read', ask: askView({ action: 'read', path: looked.path }) },
      summary,
    )
    if (refused) return refused
    const { probe } = looked
    if (probe.type === 'm' || probe.type === 'l')
      return failed('failed', `${looked.path} does not exist.`, summary)
    if (probe.type === 'd')
      return failed('invalid', `${looked.path} is a folder; use list_dir.`, summary)
    if (probe.type === 'o')
      return failed('failed', `${looked.path} is not a regular file.`, summary)
    if (probe.size == null)
      return failed('failed', `${looked.path} cannot be read (permission denied).`, summary)
    const size = probe.size
    const ext = extensionOf(looked.path).toLowerCase()
    const image = IMAGE_TYPES[ext]
    if (image) {
      if (size > IMAGE_MAX)
        return done(
          `${looked.path}: ${image}, ${sizeText(size)}: too large to show as an image (at most ${sizeText(IMAGE_MAX)}). Use copy to move it.`,
          summary,
        )
      const read = await target.request('fs/readFile', { path: looked.path }, { timeoutMs: 60_000 })
      return done(`${looked.path}: ${image}, ${sizeText(size)}`, summary, false, [
        { type: 'inputImage', imageUrl: `data:${image};base64,${read.dataBase64}` },
      ])
    }
    const known = BINARY_TYPES[ext]
    if (known) return done(binaryText(looked.path, size, known), summary)
    if (offset >= size && size > 0)
      return failed(
        'invalid',
        `offset ${offset} is past the end of ${looked.path} (${size} bytes).`,
        summary,
      )
    let bytes: Uint8Array
    if (size <= WHOLE_READ_MAX) {
      const read = await target.request('fs/readFile', { path: looked.path }, { timeoutMs: 60_000 })
      bytes = decodeBase64(read.dataBase64).subarray(offset, offset + length)
    } else {
      const result = await runScript(
        kit.runner,
        target,
        scriptCommand.readRange(looked.path, offset, length),
        {
          collect: length,
        },
      )
      bytes = result.stdout
    }
    if (looksBinary(bytes))
      return done(binaryText(looked.path, size, 'application/octet-stream'), summary)
    // 从中间读起、读到中间停下时，切开的字符不要
    const skip = offset > 0 ? utf8LeadingContinuation(bytes) : 0
    const end = offset + bytes.length < size ? utf8CompleteLength(bytes) : bytes.length
    const shown = bytes.subarray(skip, Math.max(skip, end))
    const from = offset + skip
    const to = from + shown.length
    const whole = from === 0 && to >= size
    const head = whole
      ? `${looked.path} (${size} bytes)`
      : `${looked.path}: bytes ${from}-${to} of ${size}${to < size ? `; continue with offset ${to}` : ''}`
    return done(`${head}\n${decodeUtf8(shown)}`, summary)
  } catch (error) {
    if (error instanceof ArgumentError) return failed('invalid', error.message, summary)
    return failed('failed', `Could not read the file: ${errorText(error)}`, summary)
  }
}

const binaryText = (path: string, size: number, type: string) =>
  `${path}: binary file (${type}), ${sizeText(size)}. Its content is not shown; use copy to move it to another machine.`

export async function writeFileTool(kit: ToolKit, raw: unknown): Promise<Outcome> {
  let summary = ''
  try {
    const args = asObject(raw)
    const rawPath = stringArg(args, 'path')
    summary = rawPath
    const content = args.content
    if (typeof content !== 'string') throw new ArgumentError('content must be a string')
    const mode = optionalString(args, 'mode') ?? 'create'
    if (mode !== 'create' && mode !== 'overwrite' && mode !== 'append')
      throw new ArgumentError('mode must be create, overwrite or append')
    const bytes = encodeUtf8(content)
    if (bytes.length > WRITE_MAX)
      throw new ArgumentError(`content is larger than ${sizeText(WRITE_MAX)}`)
    const target = targetOf(kit.context, args.machine)
    const facts = await target.facts()
    const looked = await lookPath(kit, target, facts, rawPath)
    summary = looked.path
    if (looked.blocked) return failed('blocked', blockedMessage(looked), summary)
    if (looked.path === '/') throw new ArgumentError('path must be a file')
    const refused = await approved(
      kit,
      { class: 'mutate', ask: askView({ action: 'write', path: looked.path }) },
      summary,
    )
    if (refused) return refused
    const { probe } = looked
    const exists = probe.type !== 'm'
    if (probe.type === 'd') return failed('invalid', `${looked.path} is a folder.`, summary)
    if (mode === 'create' && exists)
      return failed(
        'invalid',
        `${looked.path} already exists; use mode overwrite or append.`,
        summary,
      )
    const parent = looked.path.slice(0, looked.path.lastIndexOf('/')) || '/'
    if (!exists) await target.request('fs/createDirectory', { path: parent, recursive: true })
    if (mode === 'append' && exists) {
      await runScript(kit.runner, target, scriptCommand.append(looked.path), {
        collect: 1024,
        stdin: bytes,
      })
    } else {
      await target.request(
        'fs/writeFile',
        { path: looked.path, dataBase64: encodeBase64(bytes) },
        { timeoutMs: 60_000 },
      )
    }
    const verb = !exists ? 'created' : mode === 'append' ? 'appended to' : 'replaced'
    return done(`Wrote ${bytes.length} bytes to ${looked.path} (${verb}).`, summary)
  } catch (error) {
    if (error instanceof ArgumentError) return failed('invalid', error.message, summary)
    return failed('failed', `Could not write the file: ${errorText(error)}`, summary)
  }
}

const TYPE_MARK: Record<string, string> = { d: 'dir ', f: 'file', l: 'link', o: 'other' }

export async function listDirTool(kit: ToolKit, raw: unknown): Promise<Outcome> {
  let summary = ''
  try {
    const args = asObject(raw)
    const rawPath = stringArg(args, 'path')
    summary = rawPath
    const depth = optionalInt(args, 'depth', 1, 3) ?? 1
    const target = targetOf(kit.context, args.machine)
    const facts = await target.facts()
    const looked = await lookPath(kit, target, facts, rawPath)
    summary = looked.path
    if (looked.blocked) return failed('blocked', blockedMessage(looked), summary)
    const refused = await approved(
      kit,
      { class: 'read', ask: askView({ action: 'list', path: looked.path }) },
      summary,
    )
    if (refused) return refused
    if (looked.probe.type === 'm')
      return failed('failed', `${looked.path} does not exist.`, summary)
    if (looked.probe.type !== 'd')
      return failed('invalid', `${looked.path} is not a folder; use read_file.`, summary)
    const root = looked.probe.real
    // 禁止位置不往下走：列出来但标明挡住了
    const prune = looked.rules.flatMap((rule) => [rule.real, rule.expanded]).map(findPattern)
    const result = await runScript(
      kit.runner,
      target,
      scriptCommand.list(root, depth, looked.icase, prune),
      {
        collect: LIST_COLLECT,
        allowFail: true,
      },
    )
    const records = splitBytes(result.stdout, [0, 0x1e])
    const entries = []
    for (const record of records) {
      const entry = parseListed(decodeUtf8(record))
      if (entry?.path.startsWith(`${root === '/' ? '' : root}/`)) entries.push(entry)
    }
    const truncated = result.overflow || entries.length > MACHINE_LIMITS.listEntries
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const shown = entries.slice(0, MACHINE_LIMITS.listEntries)
    const cut = root === '/' ? 1 : root.length + 1
    const lines = shown.map((entry) => {
      const name = entry.path.slice(cut) + (entry.type === 'd' ? '/' : '')
      const blocked = looked.rules.some(
        (rule) =>
          entry.path === rule.real ||
          entry.path === rule.expanded ||
          (looked.icase && entry.path.toLowerCase() === rule.real.toLowerCase()),
      )
      const size = entry.type === 'f' ? String(entry.size) : '-'
      const time = entry.modifiedMs
        ? new Date(entry.modifiedMs).toISOString().replace('.000Z', 'Z')
        : '-'
      const link = entry.link ? ` -> ${entry.link}` : ''
      return `${TYPE_MARK[entry.type] ?? 'other'}  ${size.padStart(10)}  ${time}  ${name}${link}${blocked ? '  [blocked: not listed]' : ''}`
    })
    const header = `${looked.path}${root !== looked.path ? ` (resolves to ${root})` : ''}: ${shown.length} entries, depth ${depth}${truncated ? `; more entries were not listed (at most ${MACHINE_LIMITS.listEntries}), list a subfolder or use a smaller depth` : ''}`
    const problem =
      result.exitCode !== 0 && result.stderr.trim()
        ? `\nsome entries could not be read: ${result.stderr.trim().split('\n')[0]}`
        : ''
    return done(
      `${header}${problem}\ntype        size  modified              name\n${lines.join('\n')}`,
      summary,
    )
  } catch (error) {
    if (error instanceof ArgumentError) return failed('invalid', error.message, summary)
    return failed('failed', `Could not list the folder: ${errorText(error)}`, summary)
  }
}
