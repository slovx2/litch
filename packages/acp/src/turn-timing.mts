import { basename, join } from 'node:path'
import { createJsonlLog, type JsonlLog, takeLogDir } from '../../shared/src/log-file.mjs'
import type { PermissionOutcome, RequestOutcome, RequestTiming } from './connection.mjs'

// 与协议摘要共用设备的 logs/<harness>/rpc.jsonl，沿用轮转和 logs.tail 的 rpc 入口。
const directory = takeLogDir()
export const turnTimingLog: JsonlLog | null = directory
  ? createJsonlLog(join(directory, 'rpc.jsonl'), { source: basename(directory) })
  : null

interface AgentRequest {
  requestId: string | number
  method: string
  generation?: number
  toolCallId?: string
}

/** 回合内外的反向请求使用同样的事件和时钟；只记录白名单字段。 */
export function timeAgentRequest(
  mark: (event: string, fields: Record<string, unknown>) => void,
  request: AgentRequest,
  now: () => number = () => performance.now(),
): (outcome: RequestOutcome, permissionOutcome?: PermissionOutcome) => void {
  const at = now()
  mark('request.started', { ...request })
  return (outcome, permissionOutcome) =>
    mark('request.ended', {
      ...request,
      outcome,
      permissionOutcome,
      durationMs: now() - at,
    })
}

/** 只观察 ACP 边界；首块时间不是模型服务端的真实首 token 时间。 */
export class TurnTiming {
  private readonly log: JsonlLog | null
  private readonly ids: { harness: string; threadId: string; turnId: string }
  private readonly now: () => number
  private readonly start: number
  private sent: number | null = null
  private prompting = false
  private ended = false
  private first = new Set<string>()
  private tools = new Map<string, { start: number | null; ended: boolean }>()

  constructor(
    log: JsonlLog | null,
    ids: { harness: string; threadId: string; turnId: string },
    now: () => number = () => performance.now(),
  ) {
    this.log = log
    this.ids = ids
    this.now = now
    this.start = now()
    this.mark('turn.started')
  }

  mark(event: string, fields: Record<string, unknown> = {}): void {
    if (this.ended && event !== 'prompt.ended' && event !== 'request.ended') return
    const at = this.now()
    this.log?.write(`acp.${event}`, {
      ...this.ids,
      elapsedMs: at - this.start,
      ...(this.sent === null ? {} : { promptMs: at - this.sent }),
      ...fields,
    })
  }

  prompt(generation: number): RequestTiming {
    let requestId: number | undefined
    return {
      sent: (id) => {
        requestId = id
        this.sent = this.now()
        this.prompting = true
        this.mark('prompt.sent', { method: 'session/prompt', generation, requestId })
      },
      ended: (outcome, stopReason) => {
        this.prompting = false
        this.mark('prompt.ended', {
          method: 'session/prompt',
          generation,
          requestId,
          outcome,
          stopReason,
        })
      },
    }
  }

  update(patch: any): void {
    if (!this.prompting || this.ended) return
    const kind = patch?.sessionUpdate
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      // 空块和非文本内容不当作 token；思考与正文各记一次。
      if (
        patch.content?.type !== 'text' ||
        typeof patch.content.text !== 'string' ||
        !patch.content.text
      )
        return
      if (this.first.has(kind)) return
      this.first.add(kind)
      this.mark(kind === 'agent_thought_chunk' ? 'first_thought' : 'first_text')
    }
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return
    const toolCallId = patch.toolCallId
    if (typeof toolCallId !== 'string') return
    let tool = this.tools.get(toolCallId)
    if (tool?.ended) return
    const finished = patch.status === 'completed' || patch.status === 'failed'
    if (!tool) {
      // 只收到终态时明确缺少开始时间，不补造一个零耗时的调用。
      tool = { start: finished ? null : this.now(), ended: false }
      this.tools.set(toolCallId, tool)
      if (!finished) this.mark('tool.started', { toolCallId })
    }
    if (finished) {
      tool.ended = true
      this.mark('tool.ended', {
        toolCallId,
        outcome: patch.status,
        durationMs: tool.start === null ? null : this.now() - tool.start,
      })
    }
  }

  request(request: AgentRequest) {
    if (this.prompting && !this.ended)
      return timeAgentRequest((event, fields) => this.mark(event, fields), request, this.now)
  }

  finish(outcome: string): void {
    if (this.ended) return
    for (const [toolCallId, tool] of this.tools) {
      if (!tool.ended) this.mark('tool.unfinished', { toolCallId })
    }
    this.mark('turn.ended', { outcome })
    this.ended = true
  }
}
