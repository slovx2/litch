// 工具进程执行网络分块读取和本机落盘，主进程仅接收进度。
import { randomUUID } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ChannelError,
  type CoreHost,
  type FileSaveProgress,
  type FileSaveSource,
} from '@litch/core'
import {
  FILE_DOWNLOAD_CHUNK,
  type FileReadChunk,
} from '../../../packages/protocol/src/file-download.mjs'

export interface SaveTask {
  id: string
  source: FileSaveSource
  destination: string
}
export async function saveFileLocally(
  core: Pick<CoreHost, 'command'>,
  task: SaveTask,
  signal: AbortSignal,
  progress: (value: FileSaveProgress) => void,
): Promise<void> {
  const temporary = join(dirname(task.destination), `.litch-${randomUUID()}.part`)
  let output: Awaited<ReturnType<typeof open>> | null = null
  let created = false
  let bytes = 0
  let total: number | null = null
  let revision: string | undefined
  let lastProgress = 0
  const report = (state: FileSaveProgress['state'], error?: unknown) =>
    progress({
      id: task.id,
      destination: task.destination,
      bytes,
      total,
      state,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      ...(error instanceof ChannelError && error.text ? { errorText: error.text } : {}),
    })
  try {
    report('saving')
    for (;;) {
      signal.throwIfAborted()
      const result = (await core.command(
        'files.readChunk',
        { ...task.source, offset: bytes, ...(revision ? { revision } : {}) },
        signal,
      )) as FileReadChunk
      signal.throwIfAborted()
      const info = result.litchReadRange
      // 防御通道断裂或错误夹具；任何一块都不能造成无界分配、越过总长或循环不前进。
      if (
        !info ||
        !Number.isSafeInteger(info.size) ||
        info.size < bytes ||
        typeof result.dataBase64 !== 'string' ||
        result.dataBase64.length > Math.ceil(FILE_DOWNLOAD_CHUNK / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          result.dataBase64,
        ) ||
        typeof info.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(info.revision) ||
        (revision !== undefined && (revision !== info.revision || total !== info.size))
      )
        throw new Error('Invalid file chunk')
      const data = Buffer.from(result.dataBase64, 'base64')
      if (data.length !== Math.min(FILE_DOWNLOAD_CHUNK, info.size - bytes))
        throw new Error('Incomplete file chunk')
      total = info.size
      revision = info.revision
      if (!output) {
        output = await open(temporary, 'wx', 0o600)
        created = true
      }
      let written = 0
      while (written < data.length) {
        signal.throwIfAborted()
        const part = await output.write(data, written, data.length - written)
        if (!part.bytesWritten) throw new Error('Unable to write local file')
        written += part.bytesWritten
      }
      bytes += data.length
      if (Date.now() - lastProgress >= 100 || bytes === total) {
        report('saving')
        lastProgress = Date.now()
      }
      if (bytes === total) break
    }
    signal.throwIfAborted()
    await output?.sync()
    await output?.close()
    output = null
    signal.throwIfAborted()
    // 只有完整读完才替换目标；失败或取消不会留下半个目标文件，也不损坏原文件。
    await rename(temporary, task.destination)
    report('saved')
  } catch (error) {
    report(signal.aborted ? 'cancelled' : 'failed', signal.aborted ? undefined : error)
  } finally {
    await output?.close().catch(() => {})
    if (created) await rm(temporary, { force: true }).catch(() => {})
  }
}

export function createFileSaveCore(
  core: Pick<CoreHost, 'command'>,
  post: (value: FileSaveProgress) => void,
) {
  const running = new Map<string, AbortController>()
  return {
    receive(raw: unknown): boolean {
      const message = raw as {
        type?: string
        op?: string
        id?: string
        source?: FileSaveSource
        destination?: string
      } | null
      if (message?.type !== 'file-save') return false
      if (message.op === 'cancel' && message.id) running.get(message.id)?.abort()
      if (message.op !== 'start' || !message.id || !message.source || !message.destination)
        return true
      const { id, source, destination } = message
      if (running.has(id) || running.size >= 2) {
        post({
          id,
          state: 'failed',
          bytes: 0,
          total: null,
          destination,
          error: 'Too many file transfers',
        })
        return true
      }
      const abort = new AbortController()
      running.set(id, abort)
      void saveFileLocally(core, { id, source, destination }, abort.signal, post).finally(() =>
        running.delete(id),
      )
      return true
    },
    dispose() {
      for (const abort of running.values()) abort.abort()
    },
  }
}
