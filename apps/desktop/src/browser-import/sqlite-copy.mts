// 只读地打开来源浏览器的一个 SQLite 库：先连同旁路文件（-wal、-journal、-shm）拷进系统临时目录下新建的私有目录（0700），
// 只读打开拷贝，用完无论成败都删掉。不跟符号链接，不改来源里的任何文件。
import { constants, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pipeline } from 'node:stream/promises'

/** missing：没有这个库；locked：来源浏览器开着、文件被占用；failed：别的原因 */
export type CopyFailure = 'missing' | 'locked' | 'cancelled' | 'failed'

export class DatabaseCopyError extends Error {
  readonly failure: CopyFailure
  constructor(failure: CopyFailure, message: string) {
    super(message)
    this.name = 'DatabaseCopyError'
    this.failure = failure
  }
}

const SIDECARS = ['-wal', '-journal', '-shm']

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined

/** 被别的进程占着：Windows 上是共享冲突（EBUSY），SQLite 自己说的是 busy / locked */
const isLocked = (error: unknown): boolean => {
  const code = errorCode(error)
  if (code === 'EBUSY') return true
  const message = error instanceof Error ? error.message : ''
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)
}

/** 来源文件的样子：不在是 null，是符号链接或不是普通文件就拒绝 */
async function plainFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new DatabaseCopyError('failed', 'refusing to follow a symlink')
    return info.isFile()
  } catch (error) {
    if (error instanceof DatabaseCopyError) throw error
    if (errorCode(error) === 'ENOENT') return false
    if (isLocked(error)) throw new DatabaseCopyError('locked', 'the file is in use')
    throw new DatabaseCopyError('failed', 'cannot inspect the file')
  }
}

/** 打开时也不跟符号链接（有 O_NOFOLLOW 的平台上），拷成属主可读写的新文件 */
async function copyOne(source: string, target: string, signal: AbortSignal): Promise<void> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(source, flags)
  try {
    if (!(await handle.stat()).isFile()) throw new DatabaseCopyError('failed', 'not a regular file')
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      { signal },
    )
  } finally {
    await handle.close()
  }
}

/**
 * 把 source 拷一份、只读打开交给 use；use 返回之后（不管成败）关库、删目录。
 * 出错一律抛 DatabaseCopyError，消息里不带路径以外的内容
 */
export async function withDatabaseCopy<T>(
  source: string,
  signal: AbortSignal,
  use: (db: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new DatabaseCopyError('cancelled', 'cancelled')
  if (!(await plainFile(source))) throw new DatabaseCopyError('missing', 'no such database')
  const dir = await mkdtemp(join(tmpdir(), 'litch-import-'))
  let db: DatabaseSync | null = null
  try {
    await chmod(dir, 0o700)
    const copy = join(dir, 'db.sqlite')
    try {
      await copyOne(source, copy, signal)
      for (const suffix of SIDECARS) {
        if (await plainFile(source + suffix)) await copyOne(source + suffix, copy + suffix, signal)
      }
    } catch (error) {
      if (error instanceof DatabaseCopyError) throw error
      if (signal.aborted) throw new DatabaseCopyError('cancelled', 'cancelled')
      if (errorCode(error) === 'ENOENT') throw new DatabaseCopyError('missing', 'no such database')
      if (isLocked(error)) throw new DatabaseCopyError('locked', 'the file is in use')
      throw new DatabaseCopyError('failed', 'cannot copy the database')
    }
    if (signal.aborted) throw new DatabaseCopyError('cancelled', 'cancelled')
    try {
      db = new DatabaseSync(copy, { readOnly: true })
      return await use(db)
    } catch (error) {
      if (error instanceof DatabaseCopyError) throw error
      if (isLocked(error)) throw new DatabaseCopyError('locked', 'the database is locked')
      throw new DatabaseCopyError('failed', 'cannot read the database')
    }
  } finally {
    try {
      db?.close()
    } catch {
      // 关不上也要删目录
    }
    await rm(dir, { recursive: true, force: true })
  }
}
