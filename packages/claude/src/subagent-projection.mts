import { toolItemWithResult, toolResultText } from './server-helpers.mjs'
import type { RuntimeEvent, SubagentInnerEvent, ThreadItem } from './types.mjs'
import { newId, nowMillis } from './util.mjs'

// 协议层提供的最小能力：写入子线程回合的条目并通知客户端。
export interface SubagentProjectionHost {
  appendItem(item: ThreadItem): void
  updateItem(itemId: string, update: (item: ThreadItem) => ThreadItem): ThreadItem | null
  notify(method: string, params: Record<string, unknown>): void
  toolItem(event: Extract<RuntimeEvent, { type: 'tool_use' }>): ThreadItem
}

// 把子代理内部的正文、思考与工具调用投影成子线程自己的条目。
// SDK 按完整内容块转发子代理消息，所以这里每段正文是一条完整消息，不做流式去重。
export class SubagentProjection {
  private readonly host: SubagentProjectionHost
  private readonly threadId: string
  private readonly turnId: string
  // 最近一段正文先不收尾：它可能就是子代理的最终结果。
  private openMessage: { id: string; text: string } | null = null
  private readonly tools = new Map<string, { itemId: string; startedAtMs: number }>()

  constructor(host: SubagentProjectionHost, threadId: string, turnId: string) {
    this.host = host
    this.threadId = threadId
    this.turnId = turnId
  }

  handle(event: SubagentInnerEvent): void {
    if (event.type === 'text') {
      this.closeMessage('commentary')
      const item: ThreadItem = {
        type: 'agentMessage',
        id: newId(),
        text: '',
        phase: null,
        memoryCitation: null,
      }
      this.host.appendItem(item)
      this.started(item)
      this.host.updateItem(item.id, (current) =>
        current.type === 'agentMessage' ? { ...current, text: event.text } : current,
      )
      this.host.notify('item/agentMessage/delta', {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: item.id,
        delta: event.text,
      })
      this.openMessage = { id: item.id, text: event.text }
      return
    }
    this.closeMessage('commentary')
    if (event.type === 'reasoning') {
      const item: ThreadItem = { type: 'reasoning', id: newId(), summary: [], content: [] }
      this.host.appendItem(item)
      this.started(item)
      const completed = this.host.updateItem(item.id, (current) =>
        current.type === 'reasoning' ? { ...current, summary: [event.text] } : current,
      )
      const position = { threadId: this.threadId, turnId: this.turnId, itemId: item.id }
      this.host.notify('item/reasoning/summaryPartAdded', { ...position, summaryIndex: 0 })
      this.host.notify('item/reasoning/summaryTextDelta', {
        ...position,
        delta: event.text,
        summaryIndex: 0,
      })
      this.completed(completed ?? item)
      return
    }
    if (event.type === 'tool_use') {
      if (this.tools.has(event.toolUseId)) return
      const item = this.host.toolItem({ ...event, type: 'tool_use' })
      this.tools.set(event.toolUseId, { itemId: item.id, startedAtMs: nowMillis() })
      this.host.appendItem(item)
      this.started(item)
      if (item.type === 'fileChange')
        this.host.notify('item/fileChange/patchUpdated', {
          threadId: this.threadId,
          turnId: this.turnId,
          itemId: item.id,
          changes: item.changes,
        })
      return
    }
    const tool = this.tools.get(event.toolUseId)
    if (!tool) return
    this.tools.delete(event.toolUseId)
    const item = this.host.updateItem(tool.itemId, (current) =>
      toolItemWithResult(
        current,
        event.content,
        event.isError === true,
        Math.max(0, nowMillis() - tool.startedAtMs),
      ),
    )
    if (!item) return
    const output = toolResultText(event.content)
    if (item.type === 'commandExecution' && output)
      this.host.notify('item/commandExecution/outputDelta', {
        threadId: this.threadId,
        turnId: this.turnId,
        itemId: item.id,
        delta: output,
      })
    this.completed(item)
  }

  // 子代理结束。最后一段正文若就是结果，原地标为最终回答并返回 true；
  // 否则返回 false，由调用方另写一条结果消息。未完成的工具条目一并收尾。
  finish(resultText: string, failed: boolean): boolean {
    for (const [toolUseId, tool] of this.tools) {
      this.tools.delete(toolUseId)
      const item = this.host.updateItem(tool.itemId, (current) =>
        toolItemWithResult(current, '', true, Math.max(0, nowMillis() - tool.startedAtMs)),
      )
      if (item) this.completed(item)
    }
    const shown =
      !failed && this.openMessage !== null && this.openMessage.text.trim() === resultText.trim()
    this.closeMessage(shown ? 'final_answer' : 'commentary')
    return shown
  }

  private closeMessage(phase: 'commentary' | 'final_answer'): void {
    const open = this.openMessage
    if (!open) return
    this.openMessage = null
    const item = this.host.updateItem(open.id, (current) =>
      current.type === 'agentMessage' ? { ...current, phase } : current,
    )
    if (item) this.completed(item)
  }

  private started(item: ThreadItem): void {
    this.host.notify('item/started', {
      threadId: this.threadId,
      turnId: this.turnId,
      item,
      startedAtMs: nowMillis(),
    })
  }

  private completed(item: ThreadItem): void {
    this.host.notify('item/completed', {
      threadId: this.threadId,
      turnId: this.turnId,
      item,
      completedAtMs: nowMillis(),
    })
  }
}

// 追问回合的提示词：主会话只做转交，用户原文由 PreToolUse 钩子写进 SendMessage。
export function subagentRelayPrompt(agentId: string, message: string): string {
  return [
    '<subagent-follow-up>',
    `The user opened the conversation of subagent "${agentId}" and sent it a follow-up message directly.`,
    `Your only job in this turn is to deliver it: call SendMessage once with to="${agentId}". The harness replaces the message body with the user's exact text, so do not paraphrase it, answer it, or act on it yourself, and do not call any other tool.`,
    'After the subagent reports back, reply with one short sentence. The user reads the answer in the subagent conversation, not here.',
    '</subagent-follow-up>',
    '',
    '<user-message-for-subagent>',
    message,
    '</user-message-for-subagent>',
  ].join('\n')
}

// 追问回合跑在父会话上，但展示在子线程里：被恢复的子代理的输出当作本回合的正文，
// 主会话自己的输出（转交用的 SendMessage、收尾的一句话）不属于子线程，也不改写会话归属。
export function relayRuntimeEvents(
  enabled: boolean,
  handle: (event: RuntimeEvent) => Promise<void>,
): (event: RuntimeEvent) => Promise<void> {
  if (!enabled) return handle
  let sendToolUseId: string | null = null
  let delivered = false
  return async (event) => {
    switch (event.type) {
      case 'subagent_event': {
        const inner = event.event
        if (inner.type === 'text') {
          await handle({ type: 'message_boundary' })
          await handle({ type: 'text_delta', delta: inner.text })
        } else if (inner.type === 'reasoning') {
          await handle({ type: 'reasoning_delta', delta: inner.text })
        } else {
          await handle(inner)
        }
        return
      }
      case 'tool_use':
        if (event.toolName === 'SendMessage') sendToolUseId = event.toolUseId
        return
      case 'tool_result':
        if (event.toolUseId === sendToolUseId && !event.isError) delivered = true
        return
      case 'text_delta':
      case 'reasoning_delta':
      case 'message_boundary':
      case 'tool_output_delta':
      case 'plan_text':
      case 'plan_mode':
      case 'session':
      case 'native_boundary':
      case 'subagent_backgrounded':
        return
      case 'completed':
        if (event.success && !delivered) throw new Error('主会话没有把这条消息转给子代理，请重试')
        await handle({ ...event, claudeSessionId: null })
        return
      default:
        await handle(event)
    }
  }
}
