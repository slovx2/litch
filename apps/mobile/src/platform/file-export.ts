// 显式另存才逐块读取设备文件；每块写入手机缓存，不把整文件堆在 JS 内存。
import { baseName, type CoreChannel, decodeBase64 } from '@litch/core'

export interface ExportSource {
  deviceId: string
  root: string
  path: string
}
export interface ExportProgress {
  bytes: number
  total: number
}
export async function copyExportChunks(
  channel: Pick<CoreChannel, 'command'>,
  source: ExportSource,
  write: (bytes: Uint8Array, total: number) => void,
  signal: AbortSignal,
  progress: (value: ExportProgress) => void,
): Promise<void> {
  let offset = 0,
    total: number | null = null,
    revision: string | undefined
  do {
    if (signal.aborted) throw new Error('cancelled')
    const result = await channel.command(
      'files.readChunk',
      { ...source, offset, ...(revision ? { revision } : {}) },
      { signal },
    )
    if (signal.aborted) throw new Error('cancelled')
    const info = result.litchReadRange,
      bytes = decodeBase64(result.dataBase64)
    if (
      !/^[a-f0-9]{64}$/.test(info.revision) ||
      !Number.isSafeInteger(info.size) ||
      info.size < offset ||
      (total !== null && (info.size !== total || info.revision !== revision)) ||
      bytes.length > 256 * 1024 ||
      offset + bytes.length > info.size ||
      (bytes.length === 0 && offset < info.size)
    )
      throw new Error('changed')
    total = info.size
    revision = info.revision
    write(bytes, total)
    offset += bytes.length
    progress({ bytes: offset, total })
  } while (offset < (total ?? 0))
}

export async function savePhoneFile(
  channel: Pick<CoreChannel, 'command'>,
  source: ExportSource,
  signal: AbortSignal,
  progress: (value: ExportProgress) => void,
): Promise<void> {
  const [{ Directory, File, Paths, FileMode }, sharing, { randomUUID }] = await Promise.all([
    import('expo-file-system'),
    import('expo-sharing'),
    import('expo-crypto'),
  ])
  if (!(await sharing.isAvailableAsync())) throw new Error('exportUnavailable')
  const root = new Directory(Paths.cache, 'file-exports')
  root.create({ intermediates: true, idempotent: true })
  // 只回收本功能自己创建的缓存，保留最近三次以供系统分享接收方读取。
  const old = root
    .list()
    .filter((entry) => entry instanceof Directory)
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of old.slice(0, Math.max(0, old.length - 3))) entry.delete()
  const folder = new Directory(root, `${Date.now().toString(16)}-${randomUUID()}`)
  folder.create()
  const name = baseName(source.path).replace(/[\\/\u0000-\u001f]/g, '_') || 'file'
  const file = new File(folder, name)
  file.create()
  const handle = file.open(FileMode.WriteOnly)
  let complete = false
  try {
    await copyExportChunks(
      channel,
      source,
      (bytes, total) => {
        if (handle.offset === 0 && total > Paths.availableDiskSpace)
          throw new Error('exportDiskFull')
        handle.writeBytes(bytes)
      },
      signal,
      progress,
    )
    complete = true
  } finally {
    handle.close()
    if (!complete) folder.delete()
  }
  if (signal.aborted) {
    folder.delete()
    throw new Error('cancelled')
  }
  await sharing.shareAsync(file.uri)
}
