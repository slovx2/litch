// fs/watch 只负责及时提示；可见订阅用元数据对账补回丢失事件，不扫描目录内容。
import { createCancel } from '../channel/cancel.mjs'
import { RpcError } from '../connection/rpc.mjs'
import { insideRoot } from '../text/paths.mjs'
import { lacksMethod } from './faults.mjs'
import type { FilesHost } from './files.mjs'

export const FILE_RECONCILE_MS = 5000
export const FILE_RECONCILE_PARALLEL = 4

interface Entry {
  path: string
  listeners: Set<() => void>
  stamp: string | undefined
  force: boolean
  abort: (() => void) | null
}

export function createFileReconciler(host: FilesHost) {
  const entries = new Map<string, Entry>()
  const queue = new Set<Entry>()
  let timer: (() => void) | null = null
  let epoch = 0
  let running = 0
  let online = host.online()

  const active = (entry: Entry, generation: number) =>
    online && epoch === generation && entries.get(entry.path) === entry

  const probe = async (entry: Entry) => {
    const generation = epoch
    const forced = entry.force
    queue.delete(entry)
    entry.force = false
    const cancel = createCancel()
    entry.abort = () => cancel.abort()
    try {
      let stamp: string | undefined
      try {
        const meta = await host.request(
          'fs/getMetadata',
          { path: entry.path },
          { signal: cancel.signal, timeoutMs: 10_000 },
        )
        // 协议只提供毫秒级创建/修改时间。没有时间的文件系统只能重新读取来核对。
        if (meta.createdAtMs || meta.modifiedAtMs)
          stamp = JSON.stringify([
            meta.isFile,
            meta.isDirectory,
            meta.isSymlink,
            meta.createdAtMs,
            meta.modifiedAtMs,
          ])
      } catch (error) {
        if (
          error instanceof RpcError &&
          /ENOENT|ENOTDIR|no such file|os error 2\b/i.test(error.message)
        )
          stamp = 'missing'
        else if (!lacksMethod(error)) return
      }
      if (!active(entry, generation)) return
      // 首次核对也补读：初始读取和建立监听之间的变化不能被当作新基线吞掉。
      const changed = forced || stamp === undefined || stamp !== entry.stamp
      entry.stamp = stamp
      if (changed) for (const listener of entry.listeners) listener()
    } finally {
      entry.abort = null
    }
  }

  const pump = () => {
    if (!online || !host.online()) return
    for (const entry of queue) {
      if (running >= FILE_RECONCILE_PARALLEL) break
      if (entry.abort) continue
      running++
      void probe(entry).finally(() => {
        running--
        pump()
      })
    }
    if (running || timer || !entries.size) return
    // 一轮完成后再计时：慢设备不积压轮询，最多四个元数据请求同时在途。
    timer = host.clock.setTimer(() => {
      timer = null
      for (const entry of entries.values()) queue.add(entry)
      pump()
    }, FILE_RECONCILE_MS)
  }

  return {
    open(path: string, changed: () => void) {
      let entry = entries.get(path)
      if (!entry) {
        entry = { path, listeners: new Set(), stamp: undefined, force: false, abort: null }
        entries.set(path, entry)
        queue.add(entry)
      }
      entry.listeners.add(changed)
      pump()
      return () => {
        entry.listeners.delete(changed)
        if (entry.listeners.size) return
        entries.delete(path)
        queue.delete(entry)
        entry.abort?.()
        if (!entries.size) {
          timer?.()
          timer = null
        }
      }
    },
    refresh(root: string) {
      for (const entry of entries.values()) {
        if (entry.path !== root && !insideRoot(root, entry.path)) continue
        queue.add(entry)
        entry.force = true
      }
      pump()
    },
    offline() {
      online = false
      epoch++
      queue.clear()
      timer?.()
      timer = null
      for (const entry of entries.values()) entry.abort?.()
    },
    resync() {
      online = true
      epoch++
      for (const entry of entries.values()) {
        entry.stamp = undefined
        queue.add(entry)
      }
      pump()
    },
  }
}
