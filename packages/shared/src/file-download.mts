// 只为已声明 fileDownload 的连接分块读取，不把整个文件读进内存，也不跨请求持有句柄。
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import {
  FILE_DOWNLOAD_CHUNK,
  type FileReadChunk,
  type FileReadRange,
} from '../../protocol/src/file-download.mjs'
import { ProtocolError } from './protocol-contract.mjs'

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const rejected = (kind: string): never => {
  throw Object.assign(new ProtocolError(-32004, `文件另存读取失败：${kind}`), {
    data: { litchReadRange: { kind } },
  })
}

export async function readFileChunk(path: string, raw: unknown): Promise<FileReadChunk> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ProtocolError(-32602, 'litchReadRange 必须是对象')
  const { root, offset, maxBytes, revision } = raw as FileReadRange
  if (
    Object.keys(raw).some((key) => !['root', 'offset', 'maxBytes', 'revision'].includes(key)) ||
    typeof root !== 'string' ||
    !isAbsolute(root) ||
    root.includes('\0') ||
    /^[\\/]{2}/.test(root) ||
    /^[\\/]{2}/.test(path) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > FILE_DOWNLOAD_CHUNK ||
    (revision !== undefined &&
      (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) ||
    (offset > 0 && revision === undefined)
  )
    throw new ProtocolError(-32602, '分块读取参数无效')
  if (!within(root, path)) rejected('outside')
  const [base, target] = await Promise.all([realpath(root), realpath(path)])
  if (!within(base, target)) rejected('outside')
  const before = await stat(target, { bigint: true })
  if (!before.isFile()) rejected('notFile')
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) rejected('notFile')
    if (opened.dev !== before.dev || opened.ino !== before.ino) rejected('changed')
    const size = Number(opened.size)
    if (!Number.isSafeInteger(size) || offset > size) rejected('changed')
    const identity = (entry: typeof opened) =>
      createHash('sha256')
        .update(
          [base, target, entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join('\n'),
        )
        .digest('hex')
    const version = identity(opened)
    if (revision !== undefined && version !== revision) rejected('changed')
    const bytes = Buffer.allocUnsafe(Math.min(maxBytes, size - offset))
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, offset + length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    const [after, named, endRoot, endTarget] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(target, { bigint: true }),
      realpath(root),
      realpath(path),
    ])
    if (
      identity(after) !== version ||
      identity(named) !== version ||
      endRoot !== base ||
      endTarget !== target ||
      length !== bytes.length
    )
      rejected('changed')
    return { dataBase64: bytes.toString('base64'), litchReadRange: { size, revision: version } }
  } finally {
    await handle.close()
  }
}
