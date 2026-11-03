import {
  PROJECT_PERMISSION,
  type ProjectPermission,
  type ProjectPermissionRequests,
  type ProjectPermissionSet,
} from '../../../protocol/src/harness-project-permissions.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcError } from '../connection/rpc.mjs'
import type { ComposeOptions } from '../model.mjs'
import { managerValidationError } from './manager-validation.mjs'

/** 能力变更后的旧预填值只提示并退回默认，不阻断创建，也不自动写入新的权限或确认。 */
export function projectPermissionChoice(
  saved: string | null,
  options: Pick<ComposeOptions, 'permissions'> | null | undefined,
) {
  const permission = options?.permissions.some((entry) => entry.id === saved) ? saved : null
  return { permission, fallback: Boolean(saved && options && !permission) }
}

export interface ProjectPermissionView {
  deviceId: string
  cwd: string
  harness: string
  available: boolean
  record: ProjectPermission | null
}
interface Host {
  deviceId: string
  online(): boolean
  supported(): boolean
  request<M extends keyof ProjectPermissionRequests>(
    method: M,
    params: ProjectPermissionRequests[M]['params'],
  ): Promise<ProjectPermissionRequests[M]['result']>
}
export type ProjectPermissions = ReturnType<typeof createProjectPermissions>
export function createProjectPermissions(host: Host) {
  const keyOf = (cwd: string, harness: string) => JSON.stringify([cwd, harness])
  const entries = new Map<
    string,
    { cwd: string; harness: string; sinks: Set<HostSink>; epoch: number }
  >()
  const publish = (cwd: string, harness: string, record: ProjectPermission | null) => {
    const view: ProjectPermissionView = {
      deviceId: host.deviceId,
      cwd,
      harness,
      available: host.supported(),
      record,
    }
    for (const sink of entries.get(keyOf(cwd, harness))?.sinks ?? []) sink.snapshot(view)
  }
  const read = async (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    const { cwd, harness } = entry
    const epoch = ++entry.epoch
    if (!host.online() || !host.supported()) {
      publish(cwd, harness, null)
      return
    }
    try {
      const result = await host.request(PROJECT_PERMISSION.read, { cwd, harness })
      if (entry.epoch === epoch) publish(cwd, harness, result)
    } catch (error) {
      const data =
        error instanceof RpcError
          ? (error.data as {
              litch?: string
              reason?: string
              value?: string
              resolvedPath?: string
            } | null)
          : null
      const failure =
        data?.litch === 'invalidDirectory'
          ? managerValidationError(String(error), 'cwd', data.reason, data)
          : new ChannelError('rejected', String(error), undefined, { key: 'cwd' })
      if (entry.epoch === epoch) for (const sink of entry.sinks) sink.error(failure)
    }
  }
  return {
    open(cwd: string, harness: string, sink: HostSink) {
      const key = keyOf(cwd, harness)
      let entry = entries.get(key)
      if (!entry) {
        entry = { cwd, harness, sinks: new Set(), epoch: 0 }
        entries.set(key, entry)
      }
      entry.sinks.add(sink)
      void read(key)
      return () => {
        entry.sinks.delete(sink)
        if (!entry.sinks.size) {
          entry.epoch++
          entries.delete(key)
        }
      }
    },
    resync() {
      for (const cwd of entries.keys()) void read(cwd)
    },
    notification(method: string) {
      if (method !== PROJECT_PERMISSION.changed) return false
      // 不同输入路径可能 realpath 到同一目录，重读所有被订阅的目录即可正确合并别名。
      for (const cwd of entries.keys()) void read(cwd)
      return true
    },
    async set(params: ProjectPermissionSet) {
      if (!host.online()) throw new ChannelError('offline', '设备未连接')
      if (!host.supported()) throw new ChannelError('unsupported', '设备不支持项目权限')
      const record = await host.request(PROJECT_PERMISSION.set, params)
      // 保存响应已经是设备确认的值，不依赖随后的重读才能更新当前选择。
      const entry = entries.get(keyOf(params.cwd, params.harness))
      if (entry) entry.epoch++
      publish(params.cwd, params.harness, record)
      await Promise.all([...entries.keys()].map(read))
      return record
    },
  }
}
