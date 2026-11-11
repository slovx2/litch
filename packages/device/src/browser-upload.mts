import { type BigIntStats, constants } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  UPLOAD_CHUNK_BYTES,
  UPLOAD_SOURCE_MAX_BYTES,
  type UploadReadResult,
} from '../../protocol/src/browser-upload.mjs'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import { isObject } from './wire.mjs'

const failure = (kind: string, message: string) =>
  Object.assign(new ProtocolError(-32602, message), { data: { litchUpload: { kind } } })

const revision = (value: BigIntStats) =>
  [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':')

/** 不保留远程句柄：取消或断线最多留下一次有界读；每块核对打开的文件和路径，拒绝替换或改写。 */
export async function readUploadSource(params: unknown): Promise<UploadReadResult> {
  if (!isObject(params) || typeof params.path !== 'string' || !isAbsolute(params.path))
    throw failure('invalid', 'Upload requires an absolute path on the session device.')
  if (params.action !== 'stat' && params.action !== 'read')
    throw failure('invalid', 'Invalid upload read action.')
  if (
    params.action === 'read' &&
    (typeof params.version !== 'string' ||
      !Number.isSafeInteger(params.offset) ||
      (params.offset as number) < 0 ||
      !Number.isSafeInteger(params.length) ||
      (params.length as number) < 0 ||
      (params.length as number) > UPLOAD_CHUNK_BYTES)
  )
    throw failure('invalid', 'Invalid upload chunk range.')
  // 非阻塞打开防止路径被换成 FIFO 后永久等待；只接受普通文件。
  const file = await open(params.path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw failure('invalid', 'Upload source is not a file.')
    if (before.size > BigInt(UPLOAD_SOURCE_MAX_BYTES))
      throw failure('tooLarge', 'Upload source exceeds 512 MiB.')
    const version = revision(before)
    const size = Number(before.size)
    if (params.action === 'stat') return { size, version, mtimeMs: Number(before.mtimeNs) / 1e6 }
    if (version !== params.version)
      throw failure('changed', 'Upload source changed during reading.')
    const offset = params.offset as number
    const length = params.length as number
    if (offset > size || length > size - offset)
      throw failure('invalid', 'Upload chunk is outside the file.')
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const { bytesRead } = await file.read(buffer, read, length - read, offset + read)
      if (!bytesRead) throw failure('changed', 'Upload source was truncated.')
      read += bytesRead
    }
    if (
      revision(await file.stat({ bigint: true })) !== version ||
      revision(await stat(params.path, { bigint: true })) !== version
    )
      throw failure('changed', 'Upload source changed during reading.')
    return {
      size,
      version,
      mtimeMs: Number(before.mtimeNs) / 1e6,
      dataBase64: buffer.toString('base64'),
    }
  } finally {
    await file.close()
  }
}
