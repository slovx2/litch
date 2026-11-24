// 限时授权在客户端核心里的一份副本：从会话所在设备读名单（list）、跟着 changed 更新，
// 给界面订阅（按设备），给客户端工具的审批判定（这个会话、这一类此刻放不放行）。
// 授予、撤销都是用户在界面上的操作，经这里发给设备；设备是唯一的准。
import {
  findTimedApproval,
  TIMED_APPROVAL,
  type TimedApproval,
  type TimedApprovalCategory,
  type TimedApprovalRequests,
  validTimedApprovalHours,
} from '../../../protocol/src/timed-approvals.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import { RpcAbortError, RpcError } from '../connection/rpc.mjs'
import { phrase } from '../phrase.mjs'

export interface TimedApprovalsView {
  deviceId: string
  /** 设备支持限时授权（设备信息里列了扩展） */
  available: boolean
  /** 此刻生效的，按到期先后 */
  grants: TimedApproval[]
}

interface Host {
  deviceId: string
  online(): boolean
  supported(): boolean
  now(): number
  request<M extends keyof TimedApprovalRequests>(
    method: M,
    params: TimedApprovalRequests[M]['params'],
  ): Promise<TimedApprovalRequests[M]['result']>
  log?(line: string): void
}

function failure(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error
  if (error instanceof RpcAbortError)
    return new ChannelError('offline', 'Device disconnected', phrase('timedApproval.offline'))
  if (
    error instanceof RpcError &&
    (error.code === -32601 ||
      (error.data as { litch?: string } | null)?.litch === 'extensionRequired')
  )
    return new ChannelError(
      'unsupported',
      'Timed approvals unavailable',
      phrase('timedApproval.unavailable'),
    )
  return new ChannelError('rejected', 'Timed approval failed', phrase('timedApproval.failed'))
}

export type TimedApprovalsStore = ReturnType<typeof createTimedApprovals>

export function createTimedApprovals(host: Host) {
  let grants: TimedApproval[] = []
  let epoch = 0
  const sinks = new Set<HostSink>()
  const listeners = new Set<(grants: readonly TimedApproval[]) => void>()

  const live = () => grants.filter((grant) => grant.expiresAt > host.now())
  const publish = () => {
    const view: TimedApprovalsView = {
      deviceId: host.deviceId,
      available: host.supported(),
      grants: live(),
    }
    for (const sink of sinks) sink.snapshot(view)
    for (const listener of listeners) listener(view.grants)
  }
  const replace = (next: TimedApproval[]) => {
    grants = [...next].sort((a, b) => a.expiresAt - b.expiresAt)
    publish()
  }
  const read = async () => {
    const mine = ++epoch
    if (!host.supported() || !host.online()) {
      // 断线、旧设备：名单作废，客户端工具照常询问
      replace([])
      return
    }
    try {
      const result = await host.request(TIMED_APPROVAL.list, {})
      if (mine === epoch) replace(Array.isArray(result?.grants) ? result.grants : [])
    } catch (error) {
      if (mine !== epoch) return
      host.log?.(`限时授权名单读取失败：${String(error)}`)
      replace([])
    }
  }

  return {
    open(sink: HostSink) {
      sinks.add(sink)
      sink.snapshot({ deviceId: host.deviceId, available: host.supported(), grants: live() })
      return () => {
        sinks.delete(sink)
      }
    },
    /** 名单变了（含读到、断线清空）时调。返回取消 */
    onChange(listener: (grants: readonly TimedApproval[]) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    /** 这个会话、这一类此刻有没有生效的授权 */
    active(threadId: string | null, category: TimedApprovalCategory): TimedApproval | null {
      if (!threadId || !host.supported() || !host.online()) return null
      return findTimedApproval(grants, threadId, category, host.now())
    },
    resync() {
      void read()
    },
    notification(method: string, params: unknown): boolean {
      if (method !== TIMED_APPROVAL.changed) return false
      const list = (params as { grants?: unknown } | null)?.grants
      epoch++
      replace(Array.isArray(list) ? (list as TimedApproval[]) : [])
      return true
    },
    async grant(threadId: string, category: TimedApprovalCategory, hours: number) {
      if (!validTimedApprovalHours(hours))
        throw new ChannelError('invalid', 'Hours out of range', phrase('timedApproval.hoursRange'))
      if (!host.online()) throw failure(new RpcAbortError('closed', 'Device disconnected'))
      if (!host.supported()) throw failure(new RpcError(-32601, 'Timed approvals unavailable'))
      const grant = await host
        .request(TIMED_APPROVAL.grant, { threadId, category, hours })
        .catch((error: unknown) => {
          throw failure(error)
        })
      // 设备随后还会发 changed；先按应答更新，判定不用等通知
      epoch++
      replace([
        ...grants.filter((one) => !(one.threadId === threadId && one.category === category)),
        grant,
      ])
      return grant
    },
    async revoke(id: string) {
      if (!host.online()) throw failure(new RpcAbortError('closed', 'Device disconnected'))
      const result = await host.request(TIMED_APPROVAL.revoke, { id }).catch((error: unknown) => {
        throw failure(error)
      })
      epoch++
      replace(grants.filter((one) => one.id !== id))
      return result
    },
  }
}
