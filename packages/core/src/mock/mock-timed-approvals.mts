// 模拟核心里的限时授权：按设备记名单，授予、撤销、到期都给订阅者一份新快照（界面预览与测试用）。
import {
  type TimedApproval,
  type TimedApprovalCategory,
  validTimedApprovalHours,
} from '../../../protocol/src/timed-approvals.mjs'
import { ChannelError } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { TimedApprovalsView } from '../device/timed-approvals.mjs'
import { phrase } from '../phrase.mjs'

export function createMockTimedApprovals(options: {
  now(): number
  /** 授予了一条：模拟核心把这个会话里同类挂着的卡片收掉 */
  granted(deviceId: string, grant: TimedApproval): void
}) {
  const grants = new Map<string, TimedApproval[]>()
  const sinks = new Map<string, Set<HostSink>>()
  let seq = 0
  const live = (deviceId: string) =>
    (grants.get(deviceId) ?? []).filter((grant) => grant.expiresAt > options.now())
  const view = (deviceId: string): TimedApprovalsView => ({
    deviceId,
    available: true,
    grants: live(deviceId),
  })
  const publish = (deviceId: string) => {
    for (const sink of sinks.get(deviceId) ?? []) sink.snapshot(view(deviceId))
  }
  return {
    subscribe(deviceId: string, sink: HostSink) {
      const set = sinks.get(deviceId) ?? new Set<HostSink>()
      sinks.set(deviceId, set)
      set.add(sink)
      sink.snapshot(view(deviceId))
      return () => {
        set.delete(sink)
      }
    },
    active(deviceId: string, threadId: string, category: TimedApprovalCategory, scope = '') {
      return live(deviceId).some(
        (grant) =>
          grant.threadId === threadId && grant.category === category && grant.scope === scope,
      )
    },
    /** 预览场景直接放一条进去 */
    seed(deviceId: string, grant: TimedApproval) {
      grants.set(deviceId, [...(grants.get(deviceId) ?? []), grant])
    },
    grant(
      deviceId: string,
      threadId: string,
      category: TimedApprovalCategory,
      hours: number,
      scope = '',
    ) {
      if (!validTimedApprovalHours(hours))
        throw new ChannelError('invalid', 'Hours out of range', phrase('timedApproval.hoursRange'))
      const now = options.now()
      const grant: TimedApproval = {
        id: `mock-timed-${++seq}`,
        threadId,
        category,
        scope,
        grantedAt: now,
        expiresAt: now + Math.round(hours * 3_600_000),
      }
      grants.set(
        deviceId,
        [
          ...live(deviceId).filter(
            (entry) =>
              !(
                entry.threadId === threadId &&
                entry.category === category &&
                entry.scope === scope
              ),
          ),
          grant,
        ].sort((a, b) => a.expiresAt - b.expiresAt),
      )
      publish(deviceId)
      options.granted(deviceId, grant)
      return grant
    },
    revoke(deviceId: string, id: string) {
      const before = live(deviceId)
      const after = before.filter((grant) => grant.id !== id)
      grants.set(deviceId, after)
      publish(deviceId)
      return { revoked: before.length - after.length }
    },
  }
}
