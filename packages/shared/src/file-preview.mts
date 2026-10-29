// 在设备上限制实际读取量。这里只服务已声明 filePreview 的连接。
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { PREVIEW_HARD_BYTES, type PreviewFailure } from '../../protocol/src/file-preview.mjs'
import { ProtocolError } from './protocol-contract.mjs'

const reject = (kind: PreviewFailure, bytes?: number, limit?: number): never => {
  throw Object.assign(new ProtocolError(-32004, `文件预览被拒绝：${kind}`), {
    data: {
      litchPreview: {
        kind,
        ...(bytes === undefined ? {} : { bytes }),
        ...(limit === undefined ? {} : { limit }),
      },
    },
  })
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function readPreview(path: string, raw: unknown): Promise<{ dataBase64: string }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ProtocolError(-32602, 'litchPreview 必须是对象')
  const { root, maxBytes } = raw as { root?: unknown; maxBytes?: unknown }
  if (Object.keys(raw).some((key) => key !== 'root' && key !== 'maxBytes'))
    throw new ProtocolError(-32602, 'litchPreview 含未知字段')
  if (
    typeof root !== 'string' ||
    !isAbsolute(root) ||
    root.includes('\0') ||
    /^[\\/]{2}/.test(root) ||
    /^[\\/]{2}/.test(path) ||
    typeof maxBytes !== 'number' ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > PREVIEW_HARD_BYTES
  )
    throw new ProtocolError(-32602, '文件预览根目录或读取上限无效')
  if (!within(root, path)) reject('outside')
  const [base, target] = await Promise.all([realpath(root), realpath(path)])
  if (!within(base, target)) reject('outside')
  const before = await stat(target)
  if (!before.isFile()) reject('notFile')
  if (before.size > maxBytes) reject('tooLarge', before.size, maxBytes)
  // NONBLOCK 防止 stat 与 open 之间被替换成 FIFO 后挂死；NOFOLLOW 拒绝末级链接替换。
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) reject('notFile')
    if (opened.dev !== before.dev || opened.ino !== before.ino) reject('changed')
    if (opened.size > maxBytes) reject('tooLarge', opened.size, maxBytes)
    const bytes = Buffer.allocUnsafe(Math.min(opened.size + 1, maxBytes + 1))
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    const after = await handle.stat()
    const [endRoot, endTarget, named] = await Promise.all([
      realpath(root),
      realpath(path),
      stat(target),
    ])
    if (length > maxBytes || after.size > maxBytes)
      reject('tooLarge', Math.max(length, after.size), maxBytes)
    if (
      endRoot !== base ||
      endTarget !== target ||
      !within(endRoot, endTarget) ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      length !== opened.size
    )
      reject('changed')
    return { dataBase64: bytes.subarray(0, length).toString('base64') }
  } finally {
    await handle.close()
  }
}
