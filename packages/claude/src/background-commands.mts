import type { RuntimeBackgroundCommandEnd, ThreadItem } from './types.mjs'

// 后台命令的条目在命令结束前一直是 inProgress，哪怕它所在的回合早已结束。
// 这张表记着每条还在跑的命令对应哪个回合的哪个条目，命令结束时据此补发完成通知。
// 表按“进程属于哪个线程”分组；条目自己所在的线程另记（追问回合借用父线程的进程）。
export interface BackgroundCommandEntry {
  taskId: string
  threadId: string
  turnId: string
  itemId: string
  startedAtMs: number
}

export class BackgroundCommands {
  private byThread = new Map<string, Map<string, BackgroundCommandEntry>>()

  add(threadId: string, entry: BackgroundCommandEntry): void {
    const entries = this.byThread.get(threadId) ?? new Map<string, BackgroundCommandEntry>()
    entries.set(entry.taskId, entry)
    this.byThread.set(threadId, entries)
  }

  take(threadId: string, taskId: string): BackgroundCommandEntry | null {
    const entries = this.byThread.get(threadId)
    const entry = entries?.get(taskId) ?? null
    entries?.delete(taskId)
    if (entries?.size === 0) this.byThread.delete(threadId)
    return entry
  }

  drain(threadId: string): BackgroundCommandEntry[] {
    const entries = [...(this.byThread.get(threadId)?.values() ?? [])]
    this.byThread.delete(threadId)
    return entries
  }

  list(threadId: string): BackgroundCommandEntry[] {
    return [...(this.byThread.get(threadId)?.values() ?? [])]
  }

  // 条目是否属于一条还在跑的后台命令。
  isRunning(turnId: string, itemId: string): boolean {
    for (const entries of this.byThread.values())
      for (const entry of entries.values())
        if (entry.turnId === turnId && entry.itemId === itemId) return true
    return false
  }
}

// 与原生一致：退出码为 0 才算完成；被停止或随进程结束的命令记为失败，退出码 -1。
export function endedCommandItem(
  item: ThreadItem,
  end: Pick<RuntimeBackgroundCommandEnd, 'status' | 'exitCode' | 'output'>,
  durationMs: number,
): ThreadItem {
  if (item.type !== 'commandExecution') return item
  return {
    ...item,
    status: end.status === 'completed' ? 'completed' : 'failed',
    aggregatedOutput: end.output || item.aggregatedOutput,
    exitCode: end.exitCode ?? (end.status === 'completed' ? 0 : -1),
    durationMs,
  }
}
