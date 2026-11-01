/** SDK 控制请求与消息迭代器并行：计划确认须等到工具前的正文已经处理。 */
export class ToolObservation {
  private readonly seen = new Set<string>()
  private readonly pending = new Map<string, Set<(seen: boolean) => void>>()
  private closed = false

  observe(id: string): void {
    if (this.closed) return
    this.seen.add(id)
    for (const finish of this.pending.get(id) ?? []) finish(true)
  }

  wait(id: string, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return Promise.resolve(false)
    if (this.seen.has(id)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const waiting = this.pending.get(id) ?? new Set()
      this.pending.set(id, waiting)
      const abort = () => finish(false)
      const finish = (seen: boolean) => {
        signal.removeEventListener('abort', abort)
        waiting.delete(finish)
        if (!waiting.size) this.pending.delete(id)
        resolve(seen)
      }
      waiting.add(finish)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  close(): void {
    this.closed = true
    for (const waiting of this.pending.values()) for (const finish of waiting) finish(false)
    this.seen.clear()
  }
}
