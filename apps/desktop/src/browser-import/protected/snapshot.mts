import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { restrictWindowsDirectory } from './process.mjs'
import { checkCancelled, ReadFault } from './result.mjs'

const MAX_FILE = 512 * 1024 * 1024
const SIDECARS = ['', '-wal', '-journal', '-shm']

// 同时查祖先，不能只挡最终文件上的符号链接。
export async function noLinks(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new ReadFault('failed')
  const root = parse(path).root
  let part = root
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    part = join(part, component)
    if ((await lstat(part)).isSymbolicLink()) throw new ReadFault('failed')
  }
}

async function stamp(path: string): Promise<string | undefined> {
  try {
    await noLinks(path)
    const value = await lstat(path, { bigint: true })
    if (!value.isFile()) throw new ReadFault('failed')
    return `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class Snapshot {
  readonly directory: string
  private sequence = 0
  private constructor(directory: string) {
    this.directory = directory
  }

  static async create(signal: AbortSignal): Promise<Snapshot> {
    checkCancelled(signal)
    // macOS 的 /var 是系统链接；只对临时目录先取真实路径，来源路径仍严格拒绝链接。
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'litch-browser-import-'))
    try {
      await chmod(directory, 0o700)
      if (process.platform === 'win32') await restrictWindowsDirectory(directory, signal)
      checkCancelled(signal)
      return new Snapshot(directory)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }

  private async copy(source: string, destination: string, signal: AbortSignal): Promise<void> {
    checkCancelled(signal)
    await noLinks(source)
    const from = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const original = await from.stat()
      const current = await lstat(source)
      if (
        !original.isFile() ||
        current.isSymbolicLink() ||
        original.ino !== current.ino ||
        original.dev !== current.dev ||
        original.size > MAX_FILE
      )
        throw new ReadFault('failed')
      const to = await open(destination, 'wx', 0o600)
      const buffer = Buffer.alloc(1024 * 1024)
      try {
        let offset = 0
        while (offset < original.size) {
          checkCancelled(signal)
          const { bytesRead } = await from.read(
            buffer,
            0,
            Math.min(buffer.length, original.size - offset),
            offset,
          )
          if (!bytesRead) throw new ReadFault('locked')
          let written = 0
          while (written < bytesRead) {
            const result = await to.write(buffer, written, bytesRead - written, offset + written)
            if (!result.bytesWritten) throw new ReadFault('failed')
            written += result.bytesWritten
          }
          offset += bytesRead
        }
        await noLinks(source)
      } finally {
        buffer.fill(0)
        await to.close()
      }
    } finally {
      await from.close()
    }
  }

  async file(source: string, signal: AbortSignal, database = false): Promise<string | undefined> {
    const suffixes = database ? SIDECARS : ['']
    const before = await Promise.all(suffixes.map((suffix) => stamp(source + suffix)))
    if (!before[0]) return undefined
    const destination = join(this.directory, String(this.sequence++))
    for (const [index, suffix] of suffixes.entries()) {
      if (before[index]) await this.copy(source + suffix, destination + suffix, signal)
    }
    const after = await Promise.all(suffixes.map((suffix) => stamp(source + suffix)))
    if (before.some((value, index) => value !== after[index])) throw new ReadFault('locked')
    checkCancelled(signal)
    return destination
  }

  async database(source: string, signal: AbortSignal): Promise<DatabaseSync | undefined> {
    const path = await this.file(source, signal, true)
    if (!path) return undefined
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;')
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }
}

export async function validateDirectories(root: string, profile: string): Promise<void> {
  // Firefox 支持 profiles.ini 指向根目录之外的资料，归属由上层重新发现；这里不假定子目录关系。
  await noLinks(root)
  await noLinks(profile)
  if (
    !(await stat(root)).isDirectory() ||
    !(await stat(profile)).isDirectory() ||
    dirname(profile) === profile
  )
    throw new ReadFault('failed')
}
