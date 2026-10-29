import type { EngineLink } from './engine-link.mjs'
import type { TurnRecoveryObserver } from './turn-recovery.mjs'
import { DeviceError, isObject } from './wire.mjs'

/** 显式点击才执行。先确认旧回合中断，超时、换回合或仍在等工具时绝不发新回合。 */
export class RecoveryActions {
  private readonly running = new Set<string>()
  private readonly observer: TurnRecoveryObserver
  private readonly open: (harness: string) => Promise<EngineLink>
  constructor(observer: TurnRecoveryObserver, open: (harness: string) => Promise<EngineLink>) {
    this.observer = observer
    this.open = open
  }
  async continue(params: unknown): Promise<Record<string, never>> {
    if (
      !isObject(params) ||
      typeof params.harness !== 'string' ||
      typeof params.threadId !== 'string' ||
      typeof params.turnId !== 'string' ||
      typeof params.text !== 'string' ||
      !params.text.trim() ||
      params.text.length > 4000
    )
      throw new DeviceError('unsupported', 'Invalid recovery request')
    const { harness, threadId, turnId, text } = params
    const key = JSON.stringify([harness, threadId])
    if (this.running.has(key) || !this.observer.eligible(harness, threadId, turnId))
      throw new DeviceError('unsupported', 'The turn changed or is no longer waiting for recovery')
    this.running.add(key)
    let link: EngineLink | null = null
    try {
      link = await this.open(harness)
      const connected = link
      const read = (includeTurns: boolean, timeoutMs = 5000) =>
        connected.request('thread/read', { threadId, includeTurns }, { timeoutMs })
      const before = await read(true)
      const last = before?.thread?.turns?.at(-1)
      if (
        last?.id !== turnId ||
        last.status !== 'inProgress' ||
        !this.observer.eligible(harness, threadId, turnId)
      )
        throw new DeviceError('unsupported', 'The turn changed; recovery was cancelled')
      const flags = before?.thread?.status?.activeFlags
      const tools =
        Array.isArray(last.items) &&
        last.items.some(
          (item: Record<string, unknown>) =>
            item.status === 'inProgress' &&
            !['agentMessage', 'reasoning', 'userMessage', 'plan'].includes(String(item.type)),
        )
      if (
        tools ||
        (Array.isArray(flags) &&
          flags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'))
      )
        throw new DeviceError('unsupported', 'The turn is waiting for input or running a tool')
      const deadline = Date.now() + 10000
      if (!this.observer.eligible(harness, threadId, turnId))
        throw new DeviceError('unsupported', 'The turn changed; recovery was cancelled')
      await link.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 10000 })
      let confirmed = false
      let interval = 300
      const remaining = () => Math.max(1, Math.min(5000, deadline - Date.now()))
      while (Date.now() < deadline) {
        // 等中断时只看状态；离开 active 后才读一次完整历史核对回合身份与终态。
        const summary = await read(false, remaining())
        if (summary?.thread?.status?.type === 'active') {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(interval, Math.max(0, deadline - Date.now()))),
          )
          interval = 500
          continue
        }
        if (Date.now() >= deadline) break
        const state = await read(true, remaining())
        const current = state?.thread?.turns?.at(-1)
        if (current?.id !== turnId)
          throw new DeviceError('unsupported', 'A different turn has already started')
        if (current.status === 'interrupted') {
          confirmed = true
          break
        }
        if (current.status !== 'inProgress')
          throw new DeviceError('unsupported', 'The original turn already finished')
        throw new DeviceError('unsupported', 'Interruption has not completed; no new turn was sent')
      }
      if (!confirmed)
        throw new DeviceError('unsupported', 'Interruption has not completed; no new turn was sent')
      await link.request(
        'turn/start',
        { threadId, input: [{ type: 'text', text }] },
        { timeoutMs: 10000 },
      )
      return {}
    } finally {
      link?.close()
      this.running.delete(key)
    }
  }
}
