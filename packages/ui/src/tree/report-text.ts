import type { SessionPeek } from '@litch/core'

export interface ReportTextState {
  open: boolean
  busy: boolean
  text: string | null
  missing: boolean
  error: unknown
}

/** 两端共用的按需读取状态；每个来源回合独立持有，旧请求不会写进另一份回报。 */
export class ReportText {
  readonly expandable: boolean
  private state: ReportTextState = {
    open: false,
    busy: false,
    text: null,
    missing: false,
    error: null,
  }
  private listeners = new Set<() => void>()

  private readonly read: () => Promise<SessionPeek>

  constructor(
    note: { turnId: string | undefined; truncated: boolean | undefined },
    read: () => Promise<SessionPeek>,
  ) {
    this.read = read
    this.expandable = note.truncated === true && !!note.turnId
  }

  snapshot = (): ReportTextState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private update(patch: Partial<ReportTextState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  toggle = async (): Promise<void> => {
    if (!this.expandable || this.state.busy) return
    if (this.state.text !== null) {
      this.update({ open: !this.state.open })
      return
    }
    this.update({ busy: true, missing: false, error: null })
    try {
      const result = await this.read()
      if (result.answer === null) this.update({ missing: true })
      else this.update({ text: result.answer, open: true })
    } catch (error) {
      this.update({ error })
    } finally {
      this.update({ busy: false })
    }
  }
}
