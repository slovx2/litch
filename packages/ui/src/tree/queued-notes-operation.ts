// 投递属于通道和会话，关闭浮窗或切页不会丢掉在途请求与失败。两端共用。
import type { CoreChannel } from '@litch/core'

interface State {
  busy: boolean
  error: unknown | null
  notNow: boolean
}
const idle: State = { busy: false, error: null, notNow: false }
const channels = new WeakMap<CoreChannel, Map<string, QueuedNotesOperation>>()

class QueuedNotesOperation {
  private state = idle
  private listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private channel: CoreChannel
  private deviceId: string
  private sessionId: string
  constructor(channel: CoreChannel, deviceId: string, sessionId: string) {
    this.channel = channel
    this.deviceId = deviceId
    this.sessionId = sessionId
  }
  snapshot = (): State => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(state: State): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  dismiss = (): void => {
    if (!this.running) this.publish(idle)
  }
  start = (): Promise<void> => {
    if (this.running) return this.running
    this.publish({ ...idle, busy: true })
    this.running = Promise.resolve()
      .then(() =>
        this.channel.command('session.queuedNotes.deliver', {
          deviceId: this.deviceId,
          sessionId: this.sessionId,
        }),
      )
      .then(
        ({ delivered }) => this.publish({ ...idle, notNow: delivered === 'none' }),
        (error: unknown) => this.publish({ ...idle, error }),
      )
      .finally(() => {
        this.running = null
      })
    return this.running
  }
}

export function queuedNotesOperation(channel: CoreChannel, deviceId: string, sessionId: string) {
  let operations = channels.get(channel)
  if (!operations) {
    operations = new Map()
    channels.set(channel, operations)
  }
  const key = JSON.stringify([deviceId, sessionId])
  let operation = operations.get(key)
  if (!operation) {
    operation = new QueuedNotesOperation(channel, deviceId, sessionId)
    operations.set(key, operation)
  }
  return operation
}
