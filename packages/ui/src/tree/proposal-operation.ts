// 开始请求属于客户端通道，不属于弹窗。切页或关闭编辑器后，卡片仍能看到进度、错误并重试同一份任务。
import type { CoreChannel, ProposalOverrides } from '@litch/core'

export interface ProposalOperationState {
  busy: boolean
  error: unknown | null
  overrides?: ProposalOverrides | undefined
}

const idle: ProposalOperationState = { busy: false, error: null }
const channels = new WeakMap<CoreChannel, Map<string, ProposalOperation>>()

export class ProposalOperation {
  private state = idle
  private listeners = new Set<() => void>()
  private running: Promise<{ sessionId: string } | undefined> | null = null

  private channel: CoreChannel
  private deviceId: string
  private sessionId: string
  private proposalId: string
  constructor(channel: CoreChannel, deviceId: string, sessionId: string, proposalId: string) {
    this.channel = channel
    this.deviceId = deviceId
    this.sessionId = sessionId
    this.proposalId = proposalId
  }

  snapshot = (): ProposalOperationState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(state: ProposalOperationState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  start = (overrides?: ProposalOverrides): Promise<{ sessionId: string } | undefined> => {
    if (this.running) return this.running
    // 覆盖值只用于这一次开始；服务端的原提案保持原样。
    const saved = overrides ? { ...overrides } : undefined
    this.publish({ busy: true, error: null, overrides: saved })
    this.running = Promise.resolve()
      .then(() =>
        this.channel.command('session.proposal.accept', {
          deviceId: this.deviceId,
          sessionId: this.sessionId,
          proposalId: this.proposalId,
          ...(saved ? { overrides: saved } : {}),
        }),
      )
      .then(
        (result) => {
          this.publish(idle)
          return result
        },
        (error: unknown) => {
          this.publish({ busy: false, error, overrides: saved })
          return undefined
        },
      )
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  retry = () => this.start(this.state.overrides)
}

export function proposalOperation(
  channel: CoreChannel,
  deviceId: string,
  sessionId: string,
  proposalId: string,
): ProposalOperation {
  let operations = channels.get(channel)
  if (!operations) {
    operations = new Map()
    channels.set(channel, operations)
  }
  const key = JSON.stringify([deviceId, sessionId, proposalId])
  let operation = operations.get(key)
  if (!operation) {
    operation = new ProposalOperation(channel, deviceId, sessionId, proposalId)
    operations.set(key, operation)
  }
  return operation
}

/** 复用设备已有的 prompt 覆盖能力，不增加协议字段，也不会改原卡片的简报。 */
export function withProposalNote(
  prompt: string,
  note: string,
  overrides: ProposalOverrides = {},
): ProposalOverrides {
  const text = note.trim()
  return text
    ? { ...overrides, prompt: `${overrides.prompt ?? prompt}\n\n用户补充说明：\n${text}` }
    : overrides
}
