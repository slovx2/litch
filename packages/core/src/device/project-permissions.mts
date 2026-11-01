import {
  PROJECT_PERMISSION,
  type ProjectPermission,
  type ProjectPermissionRequests,
  type ProjectPermissionSet,
} from '../../../protocol/src/project-permissions.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'

export interface ProjectPermissionView {
  deviceId: string
  cwd: string
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
  const entries = new Map<string, { sinks: Set<HostSink>; epoch: number }>()
  const publish = (cwd: string, record: ProjectPermission | null) => {
    const view: ProjectPermissionView = {
      deviceId: host.deviceId,
      cwd,
      available: host.supported(),
      record,
    }
    for (const sink of entries.get(cwd)?.sinks ?? []) sink.snapshot(view)
  }
  const read = async (cwd: string) => {
    const entry = entries.get(cwd)
    if (!entry) return
    const epoch = ++entry.epoch
    if (!host.online() || !host.supported()) {
      publish(cwd, null)
      return
    }
    try {
      const result = await host.request(PROJECT_PERMISSION.read, { cwd })
      if (entry.epoch === epoch) publish(cwd, result)
    } catch (error) {
      if (entry.epoch === epoch)
        for (const sink of entry.sinks) sink.error(new ChannelError('rejected', String(error)))
    }
  }
  return {
    open(cwd: string, sink: HostSink) {
      let entry = entries.get(cwd)
      if (!entry) {
        entry = { sinks: new Set(), epoch: 0 }
        entries.set(cwd, entry)
      }
      entry.sinks.add(sink)
      void read(cwd)
      return () => {
        entry.sinks.delete(sink)
        if (!entry.sinks.size) {
          entry.epoch++
          entries.delete(cwd)
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
      await Promise.all([...entries.keys()].map(read))
      return record
    },
  }
}
