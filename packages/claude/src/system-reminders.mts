import type { ThreadItem } from './types.mjs'

// Claude Code CLI 2.1.299 的 todo_reminder / task_reminder 原文。
// 来源：CLI 附件转换器（提醒先转成 isMeta 用户消息，再用 system-reminder 包装）。
// 这里只识别完整、位于回答开头的原样复述；改版、引用和中途提及均保留。
// TaskCreate / TaskUpdate 是该版本 task_reminder 中插入的工具名。
export const CLAUDE_REMINDERS = [
  "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
] as const

/** 只缓冲已知提醒的可能前缀；第一个不匹配的字符到达便立即放出。 */
export class ReminderPrefix {
  private buffer = ''
  private released = false
  private stripped = false

  push(delta: string, final = false): string {
    if (this.released) return delta
    this.buffer += delta
    while (true) {
      const candidate = this.buffer.trimStart()
      const match = CLAUDE_REMINDERS.find(
        (text) =>
          candidate.startsWith(text) &&
          (candidate.length === text.length ? final : /\s/.test(candidate[text.length]!)),
      )
      if (match) {
        this.buffer = candidate.slice(match.length).trimStart()
        this.stripped = true
        continue
      }
      if (!final && CLAUDE_REMINDERS.some((text) => text.startsWith(candidate))) return ''
      const output = this.stripped ? candidate : this.buffer
      this.buffer = ''
      this.released = true
      return output
    }
  }
}

export const withoutReminderPrefix = (text: string): string => new ReminderPrefix().push(text, true)

/** 历史只在读取时净化，不迁移、不改写 CLI 记录或数据库里的原文。 */
export function visibleClaudeItems(items: ThreadItem[]): ThreadItem[] {
  return items.flatMap<ThreadItem>((item) => {
    if (item.type !== 'agentMessage') return [item]
    const text = withoutReminderPrefix(item.text ?? '')
    if (text === item.text) return [item]
    return text.trim() ? [{ ...item, text }] : []
  })
}

/** system、attachment 本身已由类型分流；防止带元数据标记的助手帧落入正文。 */
export const isMetaMessage = (message: { isMeta?: unknown; renderedRole?: unknown }): boolean =>
  message.isMeta === true || message.renderedRole === 'system'
