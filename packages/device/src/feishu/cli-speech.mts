// lark-cli 的发言请求：认出发给谁，按发言权限管理器的结果走。
// 自由发言的群、已绑定用户的私聊：代理直接转发；审批发言的群：原始请求冻结进发件队列转审批；其余一律拒绝。
import type { FeishuCliRequest, FeishuOutboxFormat } from '../../../protocol/src/feishu.mjs'
import type { ReviewSpeechPart } from '../../../protocol/src/reviews.mjs'
import type { CliSpeech } from './cli-policy.mjs'
import { OutboxRefusal, type OutboxTarget } from './outbox.mjs'
import type { DeviceFeishuService } from './service.mjs'
import type { SpeechPart } from './speech.mjs'
import type { FeishuAppRecord } from './store.mjs'

/** 认不出或不许的：给 CLI 的原因（英文，Agent 读） */
export class CliSpeechRefusal extends Error {}
const refuse = (message: string): never => {
  throw new CliSpeechRefusal(message)
}

export interface CliSpeechRequest {
  app: FeishuAppRecord
  speech: CliSpeech
  method: string
  /** 规范化后的路径（不带查询） */
  path: string
  query: URLSearchParams
  body: Buffer
  contentType?: string
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value)

function json(body: Buffer): Json {
  if (body.length === 0) return {}
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown
    return isObject(value) ? value : refuse('The request body must be a JSON object.')
  } catch (error) {
    if (error instanceof CliSpeechRefusal) throw error
    return refuse('The request body must be a JSON object.')
  }
}

/** 发给谁：已接入的群（按发言模式）或已绑定用户的私聊 */
export async function cliSpeechTarget(
  feishu: DeviceFeishuService,
  request: CliSpeechRequest,
): Promise<OutboxTarget> {
  const { app, speech } = request
  if (speech.type === 'opaque')
    return refuse(
      `Litch does not let lark-cli use this speaking API (${speech.action}). Send with "im +messages-send" or "im +messages-reply", or use feishu_send.`,
    )
  const receiver =
    speech.type === 'send' || (speech.type === 'message' && speech.action === 'forward')
  if (receiver) return receiverTarget(feishu, app, request)
  const chatId =
    speech.type === 'chat' ? speech.chatId : await chatOfMessage(feishu, app, speech.messageId)
  return chatTarget(feishu, app, chatId)
}

function receiverTarget(
  feishu: DeviceFeishuService,
  app: FeishuAppRecord,
  request: CliSpeechRequest,
): OutboxTarget {
  const type = request.query.get('receive_id_type')
  const id = json(request.body).receive_id
  if (typeof id !== 'string' || !id) return refuse('receive_id is missing.')
  if (type === 'chat_id') return chatTarget(feishu, app, id)
  const bound = feishu.bindings.records(app.appId).filter((one) => one.state === 'bound')
  const user =
    type === 'open_id'
      ? bound.find((one) => one.openId === id)
      : type === 'union_id'
        ? bound.find((one) => one.unionId === id)
        : type === 'user_id'
          ? bound.find((one) => one.userId === id)
          : refuse('receive_id_type must be chat_id, open_id, union_id or user_id.')
  if (!user) return refuse('The user is not bound to this Feishu app in Litch.')
  return target(feishu, app, { kind: 'user', openId: user.openId })
}

/** 群：已接入的群；私聊：已绑定用户的私聊 */
function chatTarget(feishu: DeviceFeishuService, app: FeishuAppRecord, chatId: string) {
  const binding = feishu.bindings.byChat(app.appId, chatId)
  if (binding?.state === 'bound')
    return target(feishu, app, { kind: 'user', openId: binding.openId })
  return target(feishu, app, { kind: 'chat', chatId })
}

function target(
  feishu: DeviceFeishuService,
  app: FeishuAppRecord,
  wanted: { kind: 'chat'; chatId: string } | { kind: 'user'; openId: string },
): OutboxTarget {
  try {
    return feishu.outbox.resolveTarget(app, wanted)
  } catch (error) {
    if (error instanceof OutboxRefusal) refuse(error.message)
    throw error
  }
}

/** 消息所在的会话：先查消息库，没记过的回源问一次 */
async function chatOfMessage(
  feishu: DeviceFeishuService,
  app: FeishuAppRecord,
  messageId: string,
): Promise<string> {
  const recorded = feishu.messages.get(app.appId, messageId)?.chatId
  if (recorded) return recorded
  const api = feishu.api(app.appId) ?? refuse('The Feishu app is not running.')
  try {
    const data = await api.data<{ items?: { chat_id?: unknown }[] }>(
      'GET',
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
    )
    const chatId = data.items?.[0]?.chat_id
    return typeof chatId === 'string' && chatId ? chatId : refuse('The message was not found.')
  } catch (error) {
    if (error instanceof CliSpeechRefusal) throw error
    return refuse('The message was not found or the bot cannot read it.')
  }
}

const FORMATS: Record<string, [FeishuOutboxFormat, SpeechPart['msgType']]> = {
  text: ['text', 'text'],
  post: ['post', 'post'],
  interactive: ['card', 'interactive'],
  image: ['image', 'image'],
  file: ['file', 'file'],
}

/** 审批时给人看的样子：尽量还原成文字，认不出的给原始 JSON */
export function cliSpeechPreview(request: CliSpeechRequest): {
  cli: FeishuCliRequest
  format: FeishuOutboxFormat
  msgType: SpeechPart['msgType']
  summary: string
  parts: ReviewSpeechPart[]
  replyTo?: string
} {
  const { speech } = request
  const action = speech.type === 'send' ? 'send' : speech.action
  const cli: FeishuCliRequest = {
    method: request.method as FeishuCliRequest['method'],
    path: request.path,
    action,
  }
  const body = json(request.body)
  const msgType = typeof body.msg_type === 'string' ? body.msg_type : ''
  const [format, mapped] = FORMATS[msgType] ?? ['text', 'text']
  const content = typeof body.content === 'string' ? body.content : ''
  let text = ''
  if (msgType === 'text') text = String(parsed(content)?.text ?? content)
  else if (msgType === 'post') text = postText(parsed(content)) || content
  else if (msgType === 'image' || msgType === 'file') text = ''
  else text = content || JSON.stringify(body)
  if (speech.type === 'message' && speech.action === 'forward')
    text = `Forward message ${speech.messageId}`
  if (speech.type === 'message' && speech.action === 'urgent')
    text = `Urgent notice for message ${speech.messageId}: ${JSON.stringify(body)}`
  const name =
    msgType === 'image' || msgType === 'file'
      ? String(parsed(content)?.image_key ?? parsed(content)?.file_key ?? msgType)
      : undefined
  const part: ReviewSpeechPart = name
    ? { format, name: name.slice(0, 256) }
    : { format, text: text.slice(0, 40_000) }
  return {
    cli,
    format,
    msgType: mapped,
    summary: (name ?? text).trim().slice(0, 200) || action,
    parts: [part],
    ...(speech.type === 'message' && speech.action === 'reply'
      ? { replyTo: speech.messageId }
      : {}),
  }
}

function parsed(content: string): Json | null {
  try {
    const value = JSON.parse(content) as unknown
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** 富文本里的文字：各语言取第一份，段落按行拼 */
function postText(post: Json | null): string {
  if (!post) return ''
  const body = (
    isObject(post.zh_cn) ? post.zh_cn : isObject(post.en_us) ? post.en_us : post
  ) as Json
  const lines: string[] = []
  if (typeof body.title === 'string' && body.title) lines.push(body.title)
  for (const row of Array.isArray(body.content) ? body.content : [])
    lines.push(
      (Array.isArray(row) ? row : [])
        .map((node) =>
          isObject(node)
            ? String(node.text ?? (node.tag === 'at' ? `@${node.user_name ?? node.user_id}` : ''))
            : '',
        )
        .join(''),
    )
  return lines.join('\n')
}
