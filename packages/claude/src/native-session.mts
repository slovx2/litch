import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { submissionHash } from './protocol-contract.mjs'
import type { RuntimeBackgroundCommandEnd, RuntimeTurnContext } from './types.mjs'
import { parseWorkflowCommand, workflowRuntimePrompt } from './workflow-command.mjs'

// CLI 进程在回合结束后是否留下，以及留多少个，见 docs/guide/configuration.md。
const DEFAULT_KEEP_ALIVE_SESSIONS = 8
const BACKGROUND_OUTPUT_LIMIT = 64 * 1024

type MessageUuid = `${string}-${string}-${string}-${string}-${string}`

// 同时保留后台命令的 CLI 进程数上限；0 表示回合结束就退出（后台命令随之停止）。
export function keepAliveLimit(): number {
  const raw = process.env.CHA_CLAUDE_KEEP_ALIVE_SESSIONS
  if (raw == null || raw.trim() === '') return DEFAULT_KEEP_ALIVE_SESSIONS
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_KEEP_ALIVE_SESSIONS
}

// 受限会话里 Skill 的内联 shell 必须关闭；这是进程启动时定下的设置。
export function needsStrictSkillShell(context: RuntimeTurnContext): boolean {
  return (
    context.planMode ||
    context.sandboxMode !== 'danger-full-access' ||
    context.approvalPolicy !== 'never'
  )
}

// 系统提示里不随回合变化的部分。目标说明每回合都可能变，单独随用户消息更新。
function stableAddendum(context: RuntimeTurnContext): string {
  const addendum = context.systemPromptAddendum?.trim() ?? ''
  const goal = context.goalContext?.trim()
  return goal && addendum.endsWith(goal) ? addendum.slice(0, -goal.length).trimEnd() : addendum
}

// 只能在进程启动时定下来的配置。两个回合的指纹不同，就不能共用一个进程。
export function sessionFingerprint(context: RuntimeTurnContext): string {
  return submissionHash({
    cwd: context.cwd,
    addDirs: context.addDirs,
    allowedTools: context.allowedTools,
    skillOverrides: context.skillOverrides ?? null,
    outputFormat: context.outputFormat ?? null,
    mcpServers: context.mcpServers ?? null,
    mcpConfigSource: context.mcpConfigSource ?? null,
    dynamicTools: context.dynamicTools ?? [],
    goalTools: context.goalTools === true,
    permissionTools: context.permissionTools === true,
    workflows: parseWorkflowCommand(context.prompt)?.type === 'run',
    addendum: stableAddendum(context),
  })
}

// 进程启动时的闭包（权限回调、钩子、内置工具服务）通过这个视图读写“当前回合”的上下文，
// 回合切换后不用重建。
export function liveContext(slot: { context: RuntimeTurnContext }): RuntimeTurnContext {
  return new Proxy({} as RuntimeTurnContext, {
    get: (_target, property) => Reflect.get(slot.context, property),
    set: (_target, property, value) => Reflect.set(slot.context, property, value),
    has: (_target, property) => Reflect.has(slot.context, property),
  })
}

// 进程存活期间目标变了：系统提示改不了，随下一条用户消息告诉模型。
export function goalReminder(previous: string | null, next: string | null): string | null {
  if ((previous ?? '') === (next ?? '')) return null
  const body = next
    ? `持续目标的状态有更新，以下面的内容为准：\n${next}`
    : '此前的持续目标已不再生效（已完成、已暂停或已清除），不要继续推进它，除非用户再次要求。'
  return `<system-reminder>\n${body}\n</system-reminder>`
}

// uuid 为空表示不需要按消息确认：新进程的第一条消息，它的 result 不会与别的轮次混淆。
export function userMessage(
  context: RuntimeTurnContext,
  uuid: string | null,
  reminder: string | null,
): SDKUserMessage {
  const prompt = workflowRuntimePrompt(context.prompt)
  const images = context.imageInputs ?? []
  // 斜杠命令必须保持纯文本，CLI 才会按命令解析。前面带空白（换行、空格）的也是命令，空白去掉再交给 CLI：
  // 进程里头一条消息 CLI 自己会去空白，之后的就不去了，前面带空白的原样当成一句话发给模型。后面的空白 CLI 认
  const command = prompt.trimStart().startsWith('/')
  const text = command ? prompt.trimStart() : prompt
  const note = reminder && !command ? reminder : null
  const envelope = {
    type: 'user' as const,
    ...(uuid ? { uuid: uuid as MessageUuid } : {}),
    parent_tool_use_id: null,
    origin: { kind: 'human' as const },
  }
  if (images.length === 0 && !note) return { ...envelope, message: { role: 'user', content: text } }
  const content: unknown[] = []
  if (note) content.push({ type: 'text', text: note })
  // 带图片时只能发成内容块，CLI 这时只拿最后一块文本去认斜杠命令（选的技能也是这样发的）：
  // 命令排在图片前面的话不会展开，原样当成一句话发给模型。所以命令排到图片后面，别的话照旧排在前面
  if (text && !command) content.push({ type: 'text', text })
  for (const image of images)
    content.push({
      type: 'image',
      source:
        image.kind === 'base64'
          ? { type: 'base64', media_type: image.mediaType, data: image.data }
          : { type: 'url', url: image.data },
    })
  if (command) content.push({ type: 'text', text })
  return { ...envelope, message: { role: 'user', content } } as SDKUserMessage
}

export function steerMessage(text: string, uuid: string): SDKUserMessage {
  return {
    type: 'user',
    uuid: uuid as MessageUuid,
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  }
}

// 一条 result 是否确认了给定的用户消息。用户消息可能被并进通知触发的那一轮，
// 所以按消息 ID 确认，不按 result 的来源判断。
export function resultConfirms(result: Record<string, unknown>, uuid: string): boolean {
  const ids = Array.isArray(result.user_message_uuids) ? result.user_message_uuids : []
  return result.user_message_uuid === uuid || ids.includes(uuid)
}

// 没有回合时，哪些消息说明 CLI 自己开了一轮。每一轮开头都有一条 init，模型还没开始输出
// 时回合就该出现；适配器送入的静默消息不产生 init，只有一条空 result。
export function startsRound(message: Record<string, unknown>): boolean {
  if (message.type === 'system') return message.subtype === 'init'
  if (message.type === 'stream_event' || message.type === 'assistant' || message.type === 'user')
    return true
  if (message.type !== 'result') return false
  return message.subtype !== 'success' || message.is_error === true || Number(message.num_turns) > 0
}

// 后台任务的结束通知出现在 SDK 流里之后，它触发的那一轮最迟这么久开始（空闲时实测约 60 毫秒）。
const NOTIFICATION_ROUND_GRACE_MS = 2_000
// 结束通知进入 CLI 的待办队列可能比 SDK 流里那条消息略晚；隔了这么久，它一定已在队列里。
const NOTIFICATION_SETTLE_MS = 250

// 回合要结束时，还要为结束通知触发的那一轮等多久。从通知到达起算：
// 通知与 idle 几乎同时到达才可能出现“先 idle、再开那一轮”，隔久了就不会再有。
export function notificationGraceLeft(notifiedAt: number, now: number): number {
  return Math.max(0, notifiedAt + NOTIFICATION_ROUND_GRACE_MS - now)
}

// 主循环（不是子代理）的工具结果。CLI 在它之后、下一次模型请求之前取走待办的结束通知，
// 随这次请求一起送给模型，不再为通知另起一轮；SDK 流里对此没有别的记号。
export function isMainToolResult(message: Record<string, unknown>): boolean {
  if (message.type !== 'user' || message.parent_tool_use_id || message.isReplay === true)
    return false
  const content = (message.message as { content?: unknown } | undefined)?.content
  return (
    Array.isArray(content) &&
    content.some((block) => (block as { type?: unknown } | null)?.type === 'tool_result')
  )
}

// 主循环的工具结果出现时，之前到达的结束通知算不算已经处理：已在队列里的通知要么被这一轮带走，
// 要么排在这一轮后面紧接着跑（中间没有 idle），两种情况回合结束时都不必再等。
export function notificationFolded(notifiedAt: number, now: number): boolean {
  return now - notifiedAt >= NOTIFICATION_SETTLE_MS
}

function tail(path: string): string {
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'r')
    const size = fstatSync(descriptor).size
    const length = Math.min(size, BACKGROUND_OUTPUT_LIMIT)
    const buffer = Buffer.alloc(length)
    readSync(descriptor, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } catch {
    return ''
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}

// task_notification → 后台命令的终态。退出码只出现在摘要文字里。
export function backgroundCommandEnd(
  message: Record<string, unknown>,
  toolUseId: string | null,
): RuntimeBackgroundCommandEnd {
  const summary = String(message.summary ?? '')
  const code = /exit code (-?\d+)/.exec(summary)
  const stopped = message.status === 'killed' || message.status === 'stopped'
  const exitCode = code ? Number(code[1]) : null
  const file = typeof message.output_file === 'string' ? message.output_file : ''
  return {
    taskId: String(message.task_id ?? ''),
    toolUseId,
    status: stopped
      ? 'stopped'
      : message.status === 'completed' && (exitCode ?? 0) === 0
        ? 'completed'
        : 'failed',
    exitCode,
    output: file ? tail(file) : '',
  }
}
