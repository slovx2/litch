// 文件面板共用的非递归监视。文件监视父目录并筛选目标，原子替换后仍能继续收到变化。
import type { ServerNotifications } from '../../../protocol/src/index.mjs'
import type { HostSink } from '../channel/server.mjs'
import { baseName, joinPath, normalizePath, parentPath } from '../text/paths.mjs'
import { lacksMethod } from './faults.mjs'
import { createFileReconciler } from './file-reconcile.mjs'
import type { FilesHost } from './files.mjs'

export const FILE_CHANGE_MS = 250
interface Listener {
  path: string
  directory: boolean
  sink: HostSink
  revision: number
  cancel: (() => void) | null
}
interface Watch {
  path: string
  reportedPath: string
  id: string | null
  listeners: Set<Listener>
}

export function createFileWatches(host: FilesHost, invalidate: (path: string) => void) {
  const watches = new Map<string, Watch>()
  const ids = new Map<string, Watch>()
  let sequence = 0
  let unsupported = false
  const change = (listener: Listener) => {
    invalidate(listener.path)
    listener.cancel ??= host.clock.setTimer(() => {
      listener.cancel = null
      listener.sink.snapshot({ revision: ++listener.revision })
    }, FILE_CHANGE_MS)
  }
  const reconcile = createFileReconciler(host)
  const arm = async (watch: Watch) => {
    if (!host.online() || unsupported || watch.id || !watch.listeners.size) return
    const id = `litch-files-${++sequence}`
    watch.id = id
    ids.set(id, watch)
    try {
      const result = await host.request('fs/watch', { path: watch.path, watchId: id })
      if (watch.id !== id || watches.get(watch.path) !== watch) {
        if (host.online()) void host.request('fs/unwatch', { watchId: id }).catch(() => {})
        return
      }
      watch.reportedPath = result.path ? normalizePath(result.path) : watch.path
      // 建监视期间的修改也要取到；重连时同样重新读取。
      for (const listener of watch.listeners) change(listener)
    } catch (error) {
      ids.delete(id)
      if (watch.id === id) watch.id = null
      if (lacksMethod(error)) unsupported = true
      else host.log(`文件监视失败：${String(error)}`)
    }
  }
  const stop = (watch: Watch) => {
    const id = watch.id
    watch.id = null
    if (id) {
      ids.delete(id)
      if (host.online()) void host.request('fs/unwatch', { watchId: id }).catch(() => {})
    }
  }
  return {
    open(path: string, directory: boolean, sink: HostSink): () => void {
      const watchedPath = directory ? path : (parentPath(path) ?? path)
      let watch = watches.get(watchedPath)
      if (!watch) {
        watch = { path: watchedPath, reportedPath: watchedPath, id: null, listeners: new Set() }
        watches.set(watchedPath, watch)
      }
      const listener: Listener = { path, directory, sink, revision: 0, cancel: null }
      watch.listeners.add(listener)
      sink.snapshot({ revision: 0 })
      const stopReconcile = reconcile.open(path, () => change(listener))
      // 复用已存在的父目录监视时也作废在途读取，补上订阅之前的变化。
      if (watch.id) change(listener)
      else void arm(watch)
      let closed = false
      return () => {
        if (closed) return
        closed = true
        stopReconcile()
        listener.cancel?.()
        watch.listeners.delete(listener)
        if (watch.listeners.size) return
        stop(watch)
        watches.delete(watchedPath)
      }
    },
    reconcile(root: string) {
      reconcile.refresh(root)
    },
    notification(method: string, params: unknown): boolean {
      if (method !== 'fs/changed') return false
      const { watchId, changedPaths } = params as ServerNotifications['fs/changed']
      const watch = ids.get(watchId)
      if (!watch) return false
      const comparable = (path: string) =>
        host.platform() === 'windows' ? normalizePath(path).toLowerCase() : normalizePath(path)
      const paths = Array.isArray(changedPaths) ? changedPaths.map(comparable) : []
      for (const listener of watch.listeners) {
        if (
          listener.directory ||
          !paths.length ||
          paths.some((path) =>
            [
              listener.path,
              watch.path,
              watch.reportedPath,
              joinPath(watch.reportedPath, baseName(listener.path)),
            ].some((target) => path === comparable(target)),
          )
        )
          change(listener)
      }
      return true
    },
    offline() {
      reconcile.offline()
      ids.clear()
      for (const watch of watches.values()) {
        watch.id = null
        for (const listener of watch.listeners) {
          listener.cancel?.()
          listener.cancel = null
        }
      }
    },
    resync() {
      reconcile.resync()
      unsupported = false
      for (const watch of watches.values()) void arm(watch)
    },
  }
}
