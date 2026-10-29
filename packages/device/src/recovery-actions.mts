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
      const read = (timeoutMs = 5000) =>
        connected.request('thread/read', { threadId, includeTurns: true }, { timeoutMs })
      const before = await read()
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
      await link.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 10000 })
      let confirmed = false
      while (Date.now() < deadline) {
        const state = await read(Math.max(1, Math.min(5000, deadline - Date.now())))
        const current = state?.thread?.turns?.at(-1)
        if (current?.id !== turnId)
          throw new DeviceError('unsupported', 'A different turn has already started')
        if (current.status === 'interrupted') {
          confirmed = true
          break
        }
        if (current.status !== 'inProgress')
          throw new DeviceError('unsupported', 'The original turn already finished')
        await new Promise((resolve) => setTimeout(resolve, 100))
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
