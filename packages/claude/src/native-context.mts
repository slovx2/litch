import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { contextLaunch, withFlagSettings } from './claude-provider.mjs'
import { hostClaudeEnvOverrides, hostClaudeExecutable } from './host-claude.mjs'
import type { NativeProcess } from './native-process.mjs'
import { ProtocolError } from './protocol-contract.mjs'
import { claudeSettingSources } from './runtime-config.mjs'

export type ContextBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source:
        | { type: 'url'; url: string }
        | {
            type: 'base64'
            media_type: ImageMediaType
            data: string
          }
    }

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// 一条原生消息：相邻同角色的注入条目合成一条，按原顺序追加。
export interface ContextMessage {
  uuid: string
  role: 'user' | 'assistant'
  content: ContextBlock[]
}

export interface ContextInjection {
  threadId: string
  cwd: string
  model: string | null
  // 会话所选型号的供应商；不给按 plainProvider() 算
  provider?: string | null
  sessionId: string
  existingSession: boolean
  // 这一批的编号（适配器库里的键），不是原生消息的 uuid
  messageId: string
  messages: ContextMessage[]
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProtocolError(-32602, '注入内容必须是对象')
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ProtocolError(-32602, '注入包含无法无损保留的字段')
}

// 上游收任意 Responses 条目，原样进模型上下文（不进 thread/read 的历史，也不发通知）。Claude 这边只收
// 能原样落进原生会话的两种：user 消息（文字、图片）和 assistant 消息（文字）；工具调用、推理、
// developer 消息等不能换成另一种角色去冒充，直接拒绝。
export function parseContextItems(items: unknown): Array<Omit<ContextMessage, 'uuid'>> {
  if (!Array.isArray(items) || items.length === 0)
    throw new ProtocolError(-32602, 'items 必须是非空数组')
  const messages: Array<Omit<ContextMessage, 'uuid'>> = []
  for (const value of items) {
    const item = record(value)
    keys(item, ['type', 'role', 'content'])
    if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant'))
      throw new ProtocolError(-32602, 'Claude 仅支持追加 user、assistant message')
    if (!Array.isArray(item.content) || item.content.length === 0)
      throw new ProtocolError(-32602, 'message.content 必须是非空数组')
    const role = item.role
    let last = messages.at(-1)
    if (last?.role !== role) {
      last = { role, content: [] }
      messages.push(last)
    }
    const content = last.content
    for (const raw of item.content) {
      const block = record(raw)
      if (role === 'assistant') {
        if (block.type !== 'output_text')
          throw new ProtocolError(-32602, 'Claude 注入的 assistant message 仅支持 output_text')
        keys(block, ['type', 'text'])
        if (typeof block.text !== 'string' || block.text.length === 0)
          throw new ProtocolError(-32602, 'output_text.text 必须是非空字符串')
        content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'input_text') {
        keys(block, ['type', 'text'])
        if (typeof block.text !== 'string' || block.text.length === 0)
          throw new ProtocolError(-32602, 'input_text.text 必须是非空字符串')
        content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type !== 'input_image')
        throw new ProtocolError(-32602, 'Claude 注入仅支持 input_text 和 input_image')
      keys(block, ['type', 'image_url', 'detail'])
      if (
        block.detail != null &&
        (typeof block.detail !== 'string' ||
          !['auto', 'low', 'high', 'original'].includes(block.detail))
      )
        throw new ProtocolError(-32602, '图片 detail 格式无效')
      // Claude 没有等价的精度参数；忽略合法偏好，完整保留正文和图片。
      if (typeof block.image_url !== 'string')
        throw new ProtocolError(-32602, 'input_image.image_url 必须是字符串')
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        block.image_url,
      )
      if (match) {
        const data = match[2] ?? ''
        if (Buffer.from(data, 'base64').toString('base64') !== data)
          throw new ProtocolError(-32602, '图片 base64 编码无效')
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1] as ImageMediaType, data },
        })
        continue
      }
      let url: URL
      try {
        url = new URL(block.image_url)
      } catch {
        throw new ProtocolError(-32602, '图片 URL 无效')
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new ProtocolError(-32602, '图片 URL 必须使用 HTTP(S) 且不能包含凭据')
      content.push({ type: 'image', source: { type: 'url', url: block.image_url } })
    }
  }
  return messages
}

// 注入的消息已经有几条写进了原生历史，以及当前历史的末尾边界。分批送时只会是开头连续的几条，
// 恢复时从下一条接着送；内容对不上或者顺序乱了不重放。
export async function persistedContext(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  context: ContextInjection,
): Promise<{ count: number; boundary: string | null }> {
  const history = await sdk.getSessionMessages(context.sessionId, { dir: context.cwd })
  const persisted = context.messages.map((expected) =>
    history.find((entry) => entry.uuid === expected.uuid),
  )
  persisted.forEach((message, index) => {
    if (!message) return
    const expected = context.messages[index] as ContextMessage
    const payload = message.message as Record<string, unknown>
    if (
      message.type !== expected.role ||
      payload.role !== expected.role ||
      !isDeepStrictEqual(payload.content, expected.content)
    )
      throw new ProtocolError(-32000, '原生注入 UUID 的持久内容不一致，禁止重放')
  })
  const missing = persisted.findIndex((message) => !message)
  const count = missing === -1 ? persisted.length : missing
  if (persisted.slice(count).some(Boolean))
    throw new ProtocolError(-32000, '原生注入的落盘顺序不对，禁止重放')
  return { count, boundary: history.at(-1)?.uuid ?? null }
}

// 整批都写进原生历史时返回当前历史的末尾边界，否则返回 null。
export async function persistedContextBoundary(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  context: ContextInjection,
): Promise<string | null> {
  const { count, boundary } = await persistedContext(sdk, context)
  return count === context.messages.length ? boundary : null
}

type Uuid = `${string}-${string}-${string}-${string}-${string}`

// 送给 CLI 的输入帧，分成先后几批。user 是不触发模型请求的追加（shouldQuery: false）；assistant 是
// CLI 输入流认的回放帧，一读到就收进会话，要等下一条 user 才一起落盘。所以：
// - user 后面还有 assistant 时，这条 user 自成一批，等它落盘再送下一批，不然它会排到 assistant 后面；
// - 最后一条是 assistant 时补一条空内容的 user：空的那条不落盘，只让前面的落下去。
// SDK 的类型只写了 user 帧，assistant 帧按 CLI 的输入格式给。from 是已经落盘的条数，从下一条送起。
export function contextFrameBatches(context: ContextInjection, from = 0): SDKUserMessage[][] {
  const user = (uuid: string, content: ContextBlock[]): SDKUserMessage => ({
    type: 'user',
    uuid: uuid as Uuid,
    message: { role: 'user', content },
    parent_tool_use_id: null,
    shouldQuery: false,
    client_composed: true,
  })
  const messages = context.messages.slice(from)
  const batches: SDKUserMessage[][] = [[]]
  messages.forEach((message, index) => {
    const batch = batches.at(-1) as SDKUserMessage[]
    if (message.role === 'user') {
      batch.push(user(message.uuid, message.content))
      if (index < messages.length - 1) batches.push([])
      return
    }
    batch.push({
      type: 'assistant',
      uuid: message.uuid,
      session_id: context.sessionId,
      parent_tool_use_id: null,
      message: {
        id: `msg_${message.uuid.replaceAll('-', '')}`,
        type: 'message',
        role: 'assistant',
        model: context.model ?? 'unknown',
        content: message.content,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } as unknown as SDKUserMessage)
  })
  if (messages.at(-1)?.role === 'assistant') batches.at(-1)?.push(user(randomUUID(), []))
  return batches
}

// 等某条注入的消息写进原生历史。
export async function nativeMessagePersisted(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  context: ContextInjection,
  uuid: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const history = await sdk.getSessionMessages(context.sessionId, { dir: context.cwd })
    if (history.some((entry) => entry.uuid === uuid)) return
    await delay(50, undefined, signal ? { signal } : undefined)
  }
  throw new ProtocolError(-32000, '原生历史未持久化注入 UUID，不能返回成功')
}

export async function appendNativeContext(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  context: ContextInjection,
  abort: AbortController,
  nativeProcess: NativeProcess,
): Promise<{ boundary: string }> {
  const inspect = (): Promise<string | null> => persistedContextBoundary(sdk, context)
  const done = await persistedContext(sdk, context)
  abort.signal.throwIfAborted()
  if (done.count === context.messages.length && done.boundary) return { boundary: done.boundary }
  const exists = await sdk.getSessionInfo(context.sessionId, { dir: context.cwd })
  if (context.existingSession && !exists)
    throw new ProtocolError(-32000, '原生会话缺失，不能丢弃历史后追加上下文')
  abort.signal.throwIfAborted()
  const launch = contextLaunch(context.provider, context.model)
  const options: Options = {
    pathToClaudeCodeExecutable: hostClaudeExecutable(),
    cwd: context.cwd,
    ...(context.model ? { model: context.model } : {}),
    abortController: abort,
    settingSources: claudeSettingSources(),
    settings: withFlagSettings({ disableAllHooks: true, disableSkillShellExecution: true }, launch),
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    permissionMode: 'dontAsk',
    canUseTool: async () => ({ behavior: 'deny', message: '追加上下文不能执行工具' }),
    persistSession: true,
    ...(exists ? { resume: context.sessionId } : { sessionId: context.sessionId }),
    env: {
      ...launch.env,
      ...hostClaudeEnvOverrides,
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    },
    spawnClaudeCodeProcess: nativeProcess.spawn.bind(nativeProcess),
  }
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    let previous: SDKUserMessage[] | undefined
    for (const batch of contextFrameBatches(context, done.count)) {
      if (previous) await nativeMessagePersisted(sdk, context, previous.at(-1)?.uuid, abort.signal)
      yield* batch
      previous = batch
    }
  })()
  let success = false
  for await (const message of sdk.query({ prompt, options })) {
    abort.signal.throwIfAborted()
    if (message.type === 'result') {
      if (
        message.subtype !== 'success' ||
        message.is_error ||
        message.session_id !== context.sessionId
      )
        throw new ProtocolError(-32000, 'Claude CLI 未确认上下文追加成功')
      success = true
      nativeProcess.allowGracefulClose()
    }
  }
  if (!success || !(await nativeProcess.wait(3_000)))
    throw new ProtocolError(-32000, 'Claude CLI 未成功结束上下文追加')
  abort.signal.throwIfAborted()
  const boundary = await inspect()
  if (!boundary) throw new ProtocolError(-32000, '原生历史未持久化注入 UUID，不能返回成功')
  return { boundary }
}
