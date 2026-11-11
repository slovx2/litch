import { mkdir, mkdtemp, open, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import {
  UPLOAD_CHUNK_BYTES,
  type UploadReadParams,
  type UploadReadResult,
} from '../../../../packages/protocol/src/browser-upload.mjs'

export interface PreparedUpload {
  paths: string[]
  dispose(): Promise<void>
}

/** 远程路径从不交给桌面文件系统；主进程只打开自己刚创建的私有目录。 */
export async function prepareRemoteUpload(
  paths: readonly string[],
  limits: { fileBytes: number; totalBytes: number },
  read: (params: UploadReadParams) => Promise<UploadReadResult>,
  signal: AbortSignal,
  temporaryRoot = tmpdir(),
): Promise<PreparedUpload> {
  if (!paths.length || paths.length > 32) throw new Error('Upload accepts 1 to 32 files.')
  let total = 0
  const sources: { path: string; name: string; size: number; version: string; mtimeMs: number }[] =
    []
  for (const path of paths) {
    signal.throwIfAborted()
    if ((!posix.isAbsolute(path) && !win32.isAbsolute(path)) || /[\u0000-\u001f]/.test(path))
      throw new Error(`Upload source is not an absolute path: ${path}`)
    const source = await read({ action: 'stat', path })
    signal.throwIfAborted()
    if (
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      !source.version ||
      !Number.isFinite(source.mtimeMs)
    )
      throw new Error('Invalid upload source metadata.')
    total += source.size
    if (source.size > limits.fileBytes || total > limits.totalBytes)
      throw new Error('Upload exceeds the browser file size limit.')
    const name = basename(path.includes('\\') ? win32.basename(path) : path)
    if (!name || name === '.' || name === '..') throw new Error('Invalid upload file name.')
    sources.push({
      path,
      name,
      size: source.size,
      version: source.version,
      mtimeMs: source.mtimeMs,
    })
  }
  signal.throwIfAborted()
  const directory = await mkdtemp(join(temporaryRoot, 'litch-browser-upload-'))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    const staged: string[] = []
    for (const [index, source] of sources.entries()) {
      signal.throwIfAborted()
      const folder = join(directory, String(index))
      await mkdir(folder, { mode: 0o700 })
      const path = join(folder, source.name)
      const file = await open(path, 'wx', 0o600)
      try {
        for (let offset = 0; offset < source.size; ) {
          signal.throwIfAborted()
          const length = Math.min(UPLOAD_CHUNK_BYTES, source.size - offset)
          const chunk = await read({
            action: 'read',
            path: source.path,
            version: source.version,
            offset,
            length,
          })
          signal.throwIfAborted()
          if (
            chunk.size !== source.size ||
            chunk.version !== source.version ||
            typeof chunk.dataBase64 !== 'string' ||
            chunk.dataBase64.length !== Math.ceil(length / 3) * 4
          )
            throw new Error('Upload source changed or returned an invalid chunk.')
          const bytes = Buffer.from(chunk.dataBase64, 'base64')
          if (bytes.length !== length || bytes.toString('base64') !== chunk.dataBase64)
            throw new Error('Invalid upload chunk.')
          await file.writeFile(bytes)
          offset += length
        }
        // 空文件也检查；多文件传输结束后再统一核对一次，覆盖先读完的源随后被改动。
      } finally {
        await file.close()
      }
      await utimes(path, source.mtimeMs / 1000, source.mtimeMs / 1000)
      staged.push(path)
    }
    for (const source of sources) {
      signal.throwIfAborted()
      const final = await read({
        action: 'read',
        path: source.path,
        version: source.version,
        offset: source.size,
        length: 0,
      })
      if (final.size !== source.size || final.version !== source.version || final.dataBase64 !== '')
        throw new Error('Upload source changed during reading.')
    }
    signal.throwIfAborted()
    return { paths: staged, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
