// agy 1.5.x 的 ACP prompt 结束后停止推送正文。只对已观察到的异步派发做有界历史回读。
import type { LitchBackgroundTask } from '../../protocol/src/background-tasks.mjs'

interface Entry {
  key: string
  update: any
  text?: string
}

/** 流式分块和历史整块归一：工具按原生 ID 对齐，正文仅拼接相邻的同类文本。 */
function entries(updates: readonly any[], anchor: string): Entry[] | null {
  const start = updates.findIndex((u) => u.toolCallId === anchor)
  if (start < 0) return null
  const result: Entry[] = []
  const tools = new Map<string, Entry>()
  for (const update of updates.slice(start + 1)) {
    if (update.toolCallId === anchor) continue
    if (
      ['tool_call', 'tool_call_update'].includes(update.sessionUpdate) &&
      typeof update.toolCallId === 'string'
    ) {
      const previous = tools.get(update.toolCallId)
      if (previous) previous.update = { ...previous.update, ...update }
      else {
        const entry = { key: `tool:${update.toolCallId}`, update }
        tools.set(update.toolCallId, entry)
        result.push(entry)
      }
    } else if (update.sessionUpdate === 'agent_message_chunk' && update.content) {
      if (update.content.type === 'text') {
        const text = String(update.content.text ?? '')
        if (!text) continue
        const last = result.at(-1)
        if (last?.key === 'text') last.text += text
        else result.push({ key: 'text', text, update })
      } else result.push({ key: `content:${JSON.stringify(update.content)}`, update })
    }
  }
  return result
}

/** 只接受已显示前缀之后的追加；历史不匹配时不猜、不重画，也不重复旧条目。 */
export function newAgyBackgroundUpdates(
  baseline: readonly any[],
  replay: readonly any[],
  anchor: string,
): any[] {
  const before = entries(baseline, anchor)
  const after = entries(replay, anchor)
  if (!before || !after || before.length > after.length) return []
  const added: Entry[] = []
  for (let index = 0; index < before.length; index++) {
    const a = before[index]
    const b = after[index]
    if (!a || !b || a.key !== b.key) return []
    if (a.text !== undefined) {
      if (!b.text?.startsWith(a.text)) return []
      if (a.text !== b.text) {
        if (index !== before.length - 1) return []
        added.push({ ...b, text: b.text.slice(a.text.length) })
      }
    }
  }
  added.push(...after.slice(before.length))
  // 仅有工具进展还不是父回答，继续等待。没有原生任务状态，不能标成子任务完成。
  if (!added.some((entry) => entry.key === 'text' || entry.key.startsWith('content:'))) return []
  return added.map((entry) =>
    entry.text === undefined
      ? entry.update
      : {
          ...entry.update,
          content: { type: 'text', text: entry.text },
        },
  )
}

interface Candidate {
  anchor: string
  baseline: any[]
  bytes: number
}
interface Watching extends Candidate {
  turnId: string
  startedAt: number
  attempts: number
  received: boolean
  lastChangedAt: number
  lastContent: string
  timer?: ReturnType<typeof setTimeout>
  deadline?: ReturnType<typeof setTimeout>
}

interface WatchHost {
  allowed(threadId: string): boolean
  /** 与用户 prompt 共用会话锁；返回原始回放，不向界面重复发送。 */
  replay(threadId: string): Promise<any[] | null>
  append(threadId: string, updates: any[], sourceTurnId: string): void
  changed(threadId: string): void
  expired(threadId: string): void
}
export const AGY_BACKGROUND_LIMIT_MS = 10 * 60_000
const DELAYS = [3_000, 5_000, 10_000, 20_000, 30_000]
const MAX_REPLAY_BYTES = 8 * 1024 * 1024

export class AgyBackgroundWatch {
  private readonly candidates = new Map<string, Candidate>()
  private readonly watching = new Map<string, Watching>()
  private readonly host: WatchHost
  constructor(host: WatchHost) {
    this.host = host
  }

  observe(threadId: string, update: any): void {
    if (
      ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) &&
      update.name === 'invoke_subagent' &&
      typeof update.toolCallId === 'string'
    ) {
      const previous = this.candidates.get(threadId)
      if (previous?.anchor !== update.toolCallId)
        this.candidates.set(threadId, { anchor: update.toolCallId, baseline: [], bytes: 0 })
      if (update.status === 'failed') this.candidates.delete(threadId)
    }
    const candidate = this.candidates.get(threadId)
    if (candidate) {
      candidate.baseline.push(update)
      candidate.bytes += Buffer.byteLength(JSON.stringify(update))
      if (candidate.bytes > MAX_REPLAY_BYTES) this.candidates.delete(threadId)
    }
  }

  start(threadId: string, turnId: string): void {
    const candidate = this.candidates.get(threadId)
    this.stop(threadId)
    if (!candidate || !this.host.allowed(threadId)) return
    const state: Watching = {
      ...candidate,
      turnId,
      startedAt: Date.now(),
      attempts: 0,
      received: false,
      lastChangedAt: 0,
      lastContent: '',
    }
    this.watching.set(threadId, state)
    state.deadline = setTimeout(() => {
      if (this.watching.get(threadId) !== state) return
      this.stop(threadId)
      if (!state.received) this.host.expired(threadId)
    }, AGY_BACKGROUND_LIMIT_MS)
    state.deadline.unref()
    this.host.changed(threadId)
    this.schedule(threadId, state)
  }

  private schedule(threadId: string, state: Watching): void {
    const remaining = AGY_BACKGROUND_LIMIT_MS - (Date.now() - state.startedAt)
    const quiet = state.received && Date.now() - state.lastChangedAt >= 60_000
    const delay = Math.min(
      quiet ? 60_000 : (DELAYS[Math.min(state.attempts, DELAYS.length - 1)] ?? 30_000),
      remaining,
    )
    state.timer = setTimeout(() => void this.check(threadId, state), Math.max(0, delay))
    state.timer.unref()
  }

  private async check(threadId: string, state: Watching): Promise<void> {
    if (this.watching.get(threadId) !== state) return
    if (!this.host.allowed(threadId)) return this.stop(threadId)
    if (Date.now() - state.startedAt >= AGY_BACKGROUND_LIMIT_MS) {
      this.stop(threadId)
      if (!state.received) this.host.expired(threadId)
      return
    }
    try {
      const replay = await this.host.replay(threadId)
      // 回读期间可能已收到新消息或断线；取消之后绝不追加旧结果。
      if (this.watching.get(threadId) !== state) return
      if (!this.host.allowed(threadId)) return this.stop(threadId)
      if (replay === null) {
        this.stop(threadId)
        if (!state.received) this.host.expired(threadId)
        return
      }
      const anchor = replay.findIndex((update) => update.toolCallId === state.anchor)
      const nextUser =
        anchor < 0
          ? -1
          : replay.findIndex(
              (update, index) => index > anchor && update.sessionUpdate === 'user_message_chunk',
            )
      const added = newAgyBackgroundUpdates(
        state.baseline,
        nextUser < 0 ? replay : replay.slice(0, nextUser),
        state.anchor,
      )
      const content = JSON.stringify(added)
      if (added.length && content !== state.lastContent) {
        state.received = true
        state.lastContent = content
        state.lastChangedAt = Date.now()
        this.host.append(threadId, added, state.turnId)
      }
      // 下一条用户消息是明确边界；派发工具的终态不能当作异步子任务的完成。
      if (nextUser >= 0) {
        this.stop(threadId)
        return
      }
    } catch {
      // 回读失败不触发模型、不把未知状态说成完成，仍受退避与总时长约束。
    }
    if (this.watching.get(threadId) === state) {
      state.attempts++
      this.schedule(threadId, state)
    }
  }

  stop(threadId: string): void {
    this.candidates.delete(threadId)
    const state = this.watching.get(threadId)
    if (!state) return
    clearTimeout(state.timer)
    clearTimeout(state.deadline)
    this.watching.delete(threadId)
    this.host.changed(threadId)
  }

  tasks(threadId: string): LitchBackgroundTask[] {
    const state = this.watching.get(threadId)
    // ID 标识 Litch 自己的回读监视器，不是臆造一个 agy 子任务 ID。
    return state
      ? [
          {
            id: `agy-result-watch:${state.turnId}`,
            kind: 'monitor',
            title: '子智能体可能仍在运行',
            status: 'running',
            turnId: state.turnId,
            startedAt: state.startedAt,
          },
        ]
      : []
  }

  close(): void {
    for (const id of this.watching.keys()) this.stop(id)
    this.candidates.clear()
  }
}

export const AGY_MAX_REPLAY_BYTES = MAX_REPLAY_BYTES
