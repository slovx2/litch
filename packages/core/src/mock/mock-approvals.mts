// 模拟核心里的手机批准（clientApprovals）：每台在线设备第一个不在等人答的会话上挂一张代理登录的卡片，两个打码的账号；
// 手机答了（approval.answer）就收掉。给移动端的界面预览和测试用，不验签。
import type { ApprovalCardView } from '../../../protocol/src/client-approvals.mjs'
import type { ApprovalsOp, Clock, Commands } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { ApprovalsTopicView } from '../model-approvals.mjs'

export interface MockApprovalsOptions {
  clock: Clock
  /** 这台设备上第一个不在等人答的会话；没有是 null（不挂卡片） */
  firstSession(deviceId: string): string | null
  /** 设备的名字 */
  deviceName(deviceId: string): string
}

export interface MockApprovals {
  subscribe(deviceId: string, sink: HostSink): () => void
  command(name: string, params: unknown): Promise<unknown> | undefined
}

export function createMockApprovals(options: MockApprovalsOptions): MockApprovals {
  /** 设备 → 挂着的卡片。第一次订阅时才放样例 */
  const cards = new Map<string, ApprovalCardView[]>()
  const sinks = new Map<string, Set<HostSink>>()

  const cardsOf = (deviceId: string): ApprovalCardView[] => {
    const known = cards.get(deviceId)
    if (known) return known
    const threadId = options.firstSession(deviceId)
    const sample: ApprovalCardView[] = threadId
      ? [
          {
            id: `mock-approval-${deviceId}`.padEnd(16, '0').slice(0, 64),
            threadId,
            kind: 'browserSignIn',
            summary: {
              origin: 'https://github.com',
              site: 'GitHub',
              reason: 'Open the pull request to check the CI result',
              device: options.deviceName(deviceId),
              accounts: [
                { ref: 'a1', masked: 'so•••@gmail.com' },
                { ref: 'a2', masked: 'li•••@example.com' },
              ],
              task: null,
              fillBlocked: null,
            },
            desktopId: 'mockDesktop00000',
            nonce: 'mockNonce0000000',
            expiresAt: null,
            openedAt: options.clock.now(),
          },
        ]
      : []
    cards.set(deviceId, sample)
    return sample
  }

  const view = (deviceId: string): ApprovalsTopicView => ({
    deviceId,
    available: true,
    cards: [...cardsOf(deviceId)],
  })

  return {
    subscribe(deviceId, sink) {
      const set = sinks.get(deviceId) ?? new Set()
      sinks.set(deviceId, set)
      set.add(sink)
      sink.snapshot(view(deviceId))
      return () => {
        set.delete(sink)
      }
    },
    command(name, params) {
      if (name !== 'approval.answer') return undefined
      const { deviceId, answer } = params as Commands['approval.answer']['params']
      cards.set(
        deviceId,
        cardsOf(deviceId).filter((card) => card.id !== answer?.id),
      )
      const ops: ApprovalsOp[] = [{ op: 'approvals.set', view: view(deviceId) }]
      for (const sink of sinks.get(deviceId) ?? []) sink.delta(ops)
      return Promise.resolve({})
    },
  }
}
