import {
  PROJECT_PERMISSION,
  type ProjectPermission,
  type ProjectPermissionRequests,
  type ProjectPermissionSet,
} from '../../../protocol/src/harness-project-permissions.mjs'
import { ChannelError, type ChannelErrorShape } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcAbortError, RpcError } from '../connection/rpc.mjs'
import type { ComposeOptions } from '../model.mjs'
import { phrase } from '../phrase.mjs'
import { managerValidationError } from './manager-validation.mjs'

/** 能力变更后的旧预填值只提示并退回默认，不阻断创建，也不自动写入新的权限或确认。 */
export function projectPermissionChoice(
  saved: string | null,
  options: Pick<ComposeOptions, 'permissions'> | null | undefined,
) {
  const permission = options?.permissions.some((entry) => entry.id === saved) ? saved : null
  return { permission, fallback: Boolean(saved && options && !permission) }
}

/** RPC 原文留在连接诊断里，权限状态只携带可翻译的原因。 */
function permissionFailure(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error
  const data =
    error instanceof RpcError
      ? (error.data as {
          litch?: string
          reason?: string
          value?: string
          resolvedPath?: string
        } | null)
      : null
  if (data?.litch === 'invalidDirectory')
    return managerValidationError('Invalid working directory', 'cwd', data.reason, data)
  if (error instanceof RpcAbortError) {
    if (error.reason === 'timeout')
      return new ChannelError(
        'timeout',
        'Permission request timed out',
        phrase('permission.project.timeout'),
      )
    return new ChannelError('offline', 'Device disconnected', phrase('permission.project.offline'))
  }
  if (
    error instanceof RpcError &&
    (error.code === -32601 || data?.litch === 'unsupported' || data?.litch === 'extensionRequired')
  )
    return new ChannelError(
      'unsupported',
      'Permission storage unavailable',
      phrase('permission.project.unavailable'),
    )
  return new ChannelError(
    'rejected',
    'Permission request failed',
    phrase('permission.project.failedReason'),
  )
}

export interface ProjectPermissionView {
  deviceId: string
  cwd: string
  harness: string
  available: boolean
  record: ProjectPermission | null
  failure?: ChannelErrorShape
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
  const publish = (
    cwd: string,
    harness: string,
    record: ProjectPermission | null,
    failure?: ChannelErrorShape,
  ) => {
    const view: ProjectPermissionView = {
      deviceId: host.deviceId,
      cwd,
      harness,
      available: host.supported(),
      record,
      ...(failure ? { failure } : {}),
    }
    for (const sink of entries.get(keyOf(cwd, harness))?.sinks ?? []) sink.snapshot(view)
  }
  const read = async (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    const { cwd, harness } = entry
    const epoch = ++entry.epoch
    try {
      if (!host.online()) throw new RpcAbortError('closed', 'Device disconnected')
      if (!host.supported()) throw new RpcError(-32601, 'Permission storage unavailable')
      const result = await host.request(PROJECT_PERMISSION.read, { cwd, harness })
      if (entry.epoch === epoch) publish(cwd, harness, result)
    } catch (error) {
      if (entry.epoch !== epoch) return
      // 重读失败也不能继续使用旧的权限和确认记录。
      // sink.error 会结束整个订阅；可重试失败作为状态发送，保留断线重连后的自动恢复。
      publish(cwd, harness, null, permissionFailure(error).toShape())
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
    retry(cwd: string, harness: string) {
      return read(keyOf(cwd, harness))
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
      if (!host.online())
        throw permissionFailure(new RpcAbortError('closed', 'Device disconnected'))
      if (!host.supported())
        throw permissionFailure(new RpcError(-32601, 'Permission storage unavailable'))
      const record = await host.request(PROJECT_PERMISSION.set, params).catch((error: unknown) => {
        throw permissionFailure(error)
      })
      // 保存响应已经是设备确认的值，不依赖随后的重读才能更新当前选择。
      const entry = entries.get(keyOf(params.cwd, params.harness))
      if (entry) entry.epoch++
      publish(params.cwd, params.harness, record)
      await Promise.all([...entries.keys()].map(read))
      return record
    },
  }
}
