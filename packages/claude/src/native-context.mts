import { isDeepStrictEqual } from 'node:util'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { hostClaudeExecutable } from './host-claude.mjs'
import type { NativeProcess } from './native-process.mjs'
import { ProtocolError } from './protocol-contract.mjs'

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

export interface ContextInjection {
  threadId: string
  cwd: string
  model: string | null
  sessionId: string
  existingSession: boolean
  messageId: string
  content: ContextBlock[]
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

// SDK 仅公开 user 追加入口；不能把助手、工具或多模态内容摘要成另一种角色。
export function parseContextItems(items: unknown): ContextBlock[] {
  if (!Array.isArray(items) || items.length === 0)
    throw new ProtocolError(-32602, 'items 必须是非空数组')
  const content: ContextBlock[] = []
  for (const value of items) {
    const item = record(value)
    keys(item, ['type', 'role', 'content'])
    if (item.type !== 'message' || item.role !== 'user')
      throw new ProtocolError(-32602, 'Claude 仅支持追加 user message')
    if (!Array.isArray(item.content) || item.content.length === 0)
      throw new ProtocolError(-32602, 'message.content 必须是非空数组')
    for (const raw of item.content) {
      const block = record(raw)
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
  return content
}

// 注入的消息是否已经写进原生历史；已写入时返回当前历史的末尾边界。
export async function persistedContextBoundary(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  context: ContextInjection,
): Promise<string | null> {
  const messages = await sdk.getSessionMessages(context.sessionId, { dir: context.cwd })
  const message = messages.find((entry) => entry.uuid === context.messageId)
  if (!message) return null
  const payload = message.message as Record<string, unknown>
  if (
    message.type !== 'user' ||
    payload.role !== 'user' ||
    !isDeepStrictEqual(payload.content, context.content)
  )
    throw new ProtocolError(-32000, '原生注入 UUID 的持久内容不一致，禁止重放')
  return messages.at(-1)?.uuid ?? null
}

export async function appendNativeContext(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  context: ContextInjection,
  abort: AbortController,
  nativeProcess: NativeProcess,
): Promise<{ boundary: string }> {
  const inspect = (): Promise<string | null> => persistedContextBoundary(sdk, context)
  const persisted = await inspect()
  abort.signal.throwIfAborted()
  if (persisted) return { boundary: persisted }
  const exists = await sdk.getSessionInfo(context.sessionId, { dir: context.cwd })
  if (context.existingSession && !exists)
    throw new ProtocolError(-32000, '原生会话缺失，不能丢弃历史后追加上下文')
  abort.signal.throwIfAborted()
  const options: Options = {
    pathToClaudeCodeExecutable: hostClaudeExecutable(),
    cwd: context.cwd,
    ...(context.model ? { model: context.model } : {}),
    abortController: abort,
    settingSources: ['user', 'project', 'local'],
    settings: { disableAllHooks: true, disableSkillShellExecution: true },
    strictMcpConfig: true,
    mcpServers: {},
    tools: [],
    permissionMode: 'dontAsk',
    canUseTool: async () => ({ behavior: 'deny', message: '追加上下文不能执行工具' }),
    persistSession: true,
    ...(exists ? { resume: context.sessionId } : { sessionId: context.sessionId }),
    env: {
      ...process.env,
      CLAUDE_CODE_MAX_RETRIES: '0',
      CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    },
    spawnClaudeCodeProcess: nativeProcess.spawn.bind(nativeProcess),
  }
  const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      uuid: context.messageId as `${string}-${string}-${string}-${string}-${string}`,
      message: { role: 'user', content: context.content },
      parent_tool_use_id: null,
      shouldQuery: false,
      client_composed: true,
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
