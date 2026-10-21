import { access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import type { SessionStore, StoredNativeToolIntent } from './store.mjs'
import { ToolIntentTranscripts } from './transcript-tail.mjs'
import { debugLog } from './util.mjs'

// 原生工具执行之前，入口在 PreToolUse 钩子里把这次调用记进自己的库（native_tool_intents），记上了就放行，
// 不等 CLI 把它写进会话记录（native-runtime.mts 的 buildOptions）。
//
// 为什么要记：恢复的会话里，模型只看得到 CLI 会话记录里有的东西。调用（tool_use）在记录里、结果不在时，
// CLI 恢复会话时自己补一条“这次调用被打断、结果未知，先核对再依赖或重做”的结果，模型就不会当它没发生过。
// 可 CLI 写会话记录是攒一阵（约 100 毫秒）才写一批的：入口崩溃、CLI 被强杀、机器断电时，已经放行执行的调用
// 可能还没进记录，恢复后模型不知道它发出过，可能再做一遍。
//
// 所以核对挪到不在工具调用路上的两处（server.mts 的 runRuntimeTurn）：
//   回合开始前：这个会话记着的意图逐个到会话记录里找（transcript-tail.mts，只读新增的部分）。
//     进了记录的删掉；没进、写它的 CLI 进程也已经不在了的（不会再写了），这一回合的话前面告诉模型；
//     没进、写它的 CLI 还在的（跨回合留着的进程，还没攒够一批）留着，下次再看。
//   回合结束后：再看一遍，把进了记录的删掉，免得越攒越多。
// 告诉过模型的那几条在这一回合结束后删掉；这一回合里入口又崩了的话，下次会再说一遍（宁可重复，不能漏）。
// 回退掉的回合、删掉的会话，它们的意图跟着删（store.mts）。
//
// 只有一处还要等：新会话的会话记录文件要等 CLI 第一次写才有。文件还没有时工具就执行、接着崩了，
// 下一回合连会话都恢复不了（CLI 报找不到这个会话），所以钩子在文件还不存在时等它出现（waitForTranscript）。
// CLI 收到话以后约 100 毫秒就把它写下去，真实模型想得比这久，一般用不着等；文件在了就不再看。

const NOTICE_INPUT_LIMIT = 1_000
const TRANSCRIPT_POLL_MS = 25
const TRANSCRIPT_LIMIT_MS = 3_000

/** 等新会话的会话记录文件出现（已经有了就立刻返回）；等不到或回合取消了抛错 */
export async function waitForTranscript(path: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + TRANSCRIPT_LIMIT_MS
  for (;;) {
    signal.throwIfAborted()
    try {
      await access(path)
      return
    } catch {}
    if (Date.now() >= deadline) throw new Error('会话记录文件一直没有出现')
    await delay(TRANSCRIPT_POLL_MS)
  }
}

export class NativeToolIntents {
  private readonly transcripts = new ToolIntentTranscripts()
  private readonly store: SessionStore

  constructor(store: SessionStore) {
    this.store = store
  }

  /**
   * 核对一个会话记着的意图。返回没进会话记录、写它的 CLI 也已经不在了的那些（要告诉模型）；
   * 进了记录的当场删掉，CLI 还在的留着。live 是眼下还有 CLI 进程的会话键
   */
  async settle(threadId: string, live: ReadonlySet<string>): Promise<StoredNativeToolIntent[]> {
    const rows = this.store.nativeToolIntents(threadId)
    if (rows.length === 0) return []
    const written: string[] = []
    const lost: StoredNativeToolIntent[] = []
    for (const row of rows) {
      if (await this.written(row)) written.push(row.callId)
      else if (!live.has(row.sessionKey)) lost.push(row)
    }
    this.store.dropNativeToolIntents(threadId, written)
    if (lost.length > 0)
      debugLog('native.toolIntent.lost', {
        threadId,
        calls: lost.map((row) => ({ callId: row.callId, tool: row.tool, turnId: row.turnId })),
      })
    return lost
  }

  private async written(row: StoredNativeToolIntent): Promise<boolean> {
    try {
      const event: Record<string, unknown> = { transcript_path: row.transcriptPath }
      if (row.agentId) event.agent_id = row.agentId
      return (await this.transcripts.find(event, row.callId)) !== null
    } catch {
      // 记录不见了、读不了：当作没写进去（宁可多说一句）
      return false
    }
  }
}

/** 放在这一回合的话前面，告诉模型这些调用发出过、结果未知（措辞照 CLI 自己补的那条结果） */
export function lostToolCallsNotice(rows: readonly StoredNativeToolIntent[]): string {
  const lines = rows.map((row) => {
    let input = JSON.stringify(row.input)
    if (input.length > NOTICE_INPUT_LIMIT) input = `${input.slice(0, NOTICE_INPUT_LIMIT)}…`
    const where = row.agentId ? ` (in subagent ${row.agentId})` : ''
    return `- ${row.tool}${where}: ${input}`
  })
  return [
    '<system-reminder>',
    'These tool calls from an earlier turn were started, but the session ended before they were recorded, so their outcome is unknown. Check whether each one took effect before relying on it or running it again:',
    ...lines,
    '</system-reminder>',
  ].join('\n')
}
