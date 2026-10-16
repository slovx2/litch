import { ProtocolError } from './protocol-contract.mjs'
import type { RuntimeBackgroundShell, ThreadItem } from './types.mjs'

// 对应 Codex 0.157.1 thread/backgroundTerminals/*（request_processors/thread_processor.rs）。
// Claude 的后台 shell 来自本轮 CLI 的后台 Bash 任务；processId 与 Bash 条目一致（claude:<toolUseId>），
// 因此不是原生的数字进程号，分页 cursor 也按列表顺序而非数值比较。
export interface BackgroundTerminal {
  itemId: string
  processId: string
  command: string
  cwd: string
  osPid: null
  cpuPercent: null
  rssKb: null
}

export interface ListedBackgroundTerminal {
  taskId: string
  terminal: BackgroundTerminal
}

export function backgroundTerminals(
  shells: RuntimeBackgroundShell[],
  cwd: string,
  items: ThreadItem[],
): ListedBackgroundTerminal[] {
  return [...shells]
    .sort((a, b) => a.seq - b.seq)
    .map((shell) => {
      const processId = shell.toolUseId
        ? `claude:${shell.toolUseId}`
        : `claude-task:${shell.taskId}`
      const item = items.find(
        (entry) =>
          entry.type === 'commandExecution' &&
          (entry as Record<string, unknown>).processId === processId,
      )
      return {
        taskId: shell.taskId,
        terminal: {
          itemId: item?.id ?? shell.toolUseId ?? shell.taskId,
          processId,
          command: shell.command,
          cwd,
          osPid: null,
          cpuPercent: null,
          rssKb: null,
        },
      }
    })
}

export function paginateBackgroundTerminals(
  terminals: BackgroundTerminal[],
  cursor: unknown,
  limit: unknown,
): { data: BackgroundTerminal[]; nextCursor: string | null } {
  if (cursor != null && typeof cursor !== 'string')
    throw new ProtocolError(-32602, 'cursor 必须是字符串')
  if (limit != null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0))
    throw new ProtocolError(-32602, 'limit 必须是非负整数')
  // 原生：从第一个“排在 cursor 之后”的条目开始；cursor 已不在列表中时返回空页。
  const start =
    cursor == null
      ? 0
      : (() => {
          const index = terminals.findIndex((terminal) => terminal.processId === cursor)
          return index < 0 ? terminals.length : index + 1
        })()
  const effectiveLimit = Math.max(1, (limit as number | null | undefined) ?? terminals.length)
  const end = Math.min(terminals.length, start + effectiveLimit)
  return {
    data: terminals.slice(start, end),
    nextCursor: end < terminals.length ? (terminals[end - 1]?.processId ?? null) : null,
  }
}
