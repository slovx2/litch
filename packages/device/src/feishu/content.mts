// 飞书消息转文字：把各类消息的 content JSON 渲染成一段给人和经理看的文字，外加附件清单。
// 覆盖飞书“接收消息内容”文档里的全部类型；不认识的新类型留一行占位，不静默丢掉。
// 合并转发、卡片、群名片、个人名片要回源才能看全（detail），回源后的渲染也在这里。

/** 单条正文最多多少字，超了截断并注明 */
export const FEISHU_TEXT_LIMIT = 20_000
/** 合并转发最多展开多少条子消息 */
export const FORWARD_CHILD_LIMIT = 50

export type AttachmentKind = 'image' | 'file' | 'audio' | 'media'

export interface ParsedAttachment {
  kind: AttachmentKind
  fileKey: string
  name: string
  /** 下载资源时用哪条消息的 ID：合并转发里的子消息要挂在父消息上下载 */
  resourceMessageId: string
  /** 视频的封面图 */
  coverImageKey?: string
}

export type DetailKind = 'merge_forward' | 'interactive' | 'share_chat' | 'share_user'

export interface ParsedContent {
  text: string
  attachments: ParsedAttachment[]
  /** 要回源才能看全的类型 */
  detail?: DetailKind
  /** 群名片、个人名片里的 ID，回源时换成名字 */
  sharedId?: string
}

export interface MentionRef {
  /** 正文里的占位符，比如 `@_user_1` */
  key: string
  name: string
}

export interface ParseOptions {
  messageId: string
  resourceMessageId?: string
  mentions?: MentionRef[]
}

type Json = Record<string, unknown>

const str = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  return (typeof value === 'string' ? value : String(value)).trim()
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** content 字段可能是 JSON 字符串、对象，也可能是一句固定的话（合并转发） */
export function contentObject(raw: unknown): Json {
  if (isObject(raw)) return raw
  if (typeof raw !== 'string') return {}
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    if (isObject(parsed)) return parsed
    if (Array.isArray(parsed)) return { content: parsed }
    return { text: String(parsed) }
  } catch {
    return { text: raw }
  }
}

export function clip(text: string, limit = FEISHU_TEXT_LIMIT): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n[正文过长，已截断，原文 ${text.length} 字]`
}

const joinLines = (parts: string[]): string =>
  parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')

const shortKey = (key: string): string => key.replaceAll('/', '_').slice(-12)

function imageAttachment(
  imageKey: string,
  resourceMessageId: string,
  index: number,
  name?: string,
): ParsedAttachment {
  return {
    kind: 'image',
    fileKey: imageKey,
    name: name || `feishu-image-${index + 1}-${shortKey(imageKey) || resourceMessageId}.png`,
    resourceMessageId,
  }
}

const LABELS: Record<AttachmentKind, string> = {
  image: '图片',
  file: '文件',
  audio: '语音',
  media: '视频',
}

const noteOf = (attachment: ParsedAttachment): string =>
  `[${LABELS[attachment.kind]}] ${attachment.name}`

function durationLabel(value: unknown): string {
  const seconds = Math.round(Number(value) / 1000)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `（${minutes}分${rest}秒）` : `（${rest}秒）`
}

/** 毫秒时间戳写成 UTC 的“年-月-日 时:分”；不是数字的原样返回 */
export function formatFeishuTime(value: unknown): string {
  const text = str(value)
  if (!text) return ''
  const ms = Number(text)
  if (!Number.isFinite(ms)) return text
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function replaceMentions(text: string, mentions: MentionRef[] | undefined): string {
  let result = text
  // 先换长的占位符，免得 @_user_1 吃掉 @_user_10 的前缀
  for (const mention of [...(mentions ?? [])].sort((a, b) => b.key.length - a.key.length))
    if (mention.key) result = result.replaceAll(mention.key, `@${mention.name || mention.key}`)
  return result
}

/** 富文本按语言取一份：优先中文，其次任意一份带 content 的 */
function postLocale(payload: Json): Json | null {
  if (isObject(payload.zh_cn)) return payload.zh_cn
  for (const value of Object.values(payload))
    if (isObject(value) && Array.isArray(value.content)) return value
  return Array.isArray(payload.content) ? payload : null
}

function postAttachment(
  tag: string,
  item: Json,
  resourceMessageId: string,
  index: number,
): ParsedAttachment | null {
  const fileKey = str(item.file_key)
  if (tag === 'img') {
    const imageKey = str(item.image_key)
    return imageKey ? imageAttachment(imageKey, resourceMessageId, index) : null
  }
  if (tag === 'media' && fileKey)
    return {
      kind: 'media',
      fileKey,
      name: str(item.file_name) || `feishu-media-${index + 1}.mp4`,
      resourceMessageId,
    }
  if (tag === 'file' && fileKey && str(item.file_name))
    return { kind: 'file', fileKey, name: str(item.file_name), resourceMessageId }
  if (tag === 'audio' && fileKey)
    return {
      kind: 'audio',
      fileKey,
      name: `feishu-audio-${index + 1}-${shortKey(fileKey) || resourceMessageId}`,
      resourceMessageId,
    }
  return null
}

function parsePost(payload: Json, resourceMessageId: string): ParsedContent {
  const locale = postLocale(payload)
  if (!locale) return { text: '', attachments: [] }
  const title = str(locale.title)
  const lines: string[] = []
  const attachments: ParsedAttachment[] = []
  for (const paragraph of Array.isArray(locale.content) ? locale.content : []) {
    if (!Array.isArray(paragraph)) continue
    const parts: string[] = []
    for (const item of paragraph) {
      if (!isObject(item)) continue
      const tag = str(item.tag)
      if (tag === 'text' || tag === 'md') parts.push(str(item.text))
      else if (tag === 'a') {
        const label = str(item.text)
        const href = str(item.href)
        parts.push(label && href && label !== href ? `${label}(${href})` : label || href)
      } else if (tag === 'at') {
        const who = str(item.user_name) || str(item.user_id)
        if (who) parts.push(`@${who}`)
      } else if (tag === 'emotion') parts.push('[表情]')
      else if (tag === 'code_block') parts.push(str(item.text))
      else if (tag === 'hr') parts.push('———')
      else {
        const attachment = postAttachment(tag, item, resourceMessageId, attachments.length)
        if (attachment) {
          attachments.push(attachment)
          parts.push(noteOf(attachment))
        }
      }
    }
    const line = parts.join('').trim()
    if (line) lines.push(line)
  }
  return { text: joinLines([title, ...lines]), attachments }
}

function render(template: string, payload: Json): string {
  let rendered = template
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'template') continue
    const placeholder = `{${key}}`
    if (!rendered.includes(placeholder)) continue
    let text = ''
    if (Array.isArray(value)) text = value.map(str).filter(Boolean).join('、')
    else if (isObject(value)) text = str(value.text) || str(value.name) || str(value.value)
    else text = str(value)
    rendered = rendered.replaceAll(placeholder, text)
  }
  return rendered.replace(/\{[a-z_]+\}/g, '').trim()
}

function todoTitle(payload: Json): string {
  const summary = isObject(payload.summary) ? postLocale(payload.summary) : null
  if (!summary) return ''
  const parts: string[] = []
  for (const paragraph of Array.isArray(summary.content) ? summary.content : [])
    if (Array.isArray(paragraph))
      for (const item of paragraph) if (isObject(item)) parts.push(str(item.text))
  return parts.join('').trim() || str(summary.title)
}

function between(start: string, end: string): string {
  if (start && end) return `（${start} ~ ${end}）`
  return start ? `（${start}）` : ''
}

/** 把一条消息的 content 渲染成文字和附件 */
export function parseContent(msgType: string, raw: unknown, options: ParseOptions): ParsedContent {
  const type = str(msgType)
  const payload = contentObject(raw)
  const resource = options.resourceMessageId ?? options.messageId
  const only = (text: string): ParsedContent => ({ text, attachments: [] })
  const single = (attachment: ParsedAttachment, note = noteOf(attachment)): ParsedContent => ({
    text: note,
    attachments: [attachment],
  })
  switch (type) {
    case 'text':
      return only(replaceMentions(str(payload.text), options.mentions))
    case 'post': {
      const parsed = parsePost(payload, resource)
      return { ...parsed, text: replaceMentions(parsed.text, options.mentions) }
    }
    case 'image': {
      const imageKey = str(payload.image_key)
      return imageKey
        ? single(imageAttachment(imageKey, resource, 0, str(payload.file_name)))
        : only('[图片]')
    }
    case 'file': {
      const fileKey = str(payload.file_key)
      const name = str(payload.file_name)
      if (!fileKey || !name) return only('[文件]（缺少文件名或文件标识）')
      return single({ kind: 'file', fileKey, name, resourceMessageId: resource })
    }
    case 'audio': {
      const fileKey = str(payload.file_key)
      if (!fileKey) return only('[语音]')
      const name = `feishu-audio-${shortKey(fileKey) || options.messageId}`
      const attachment: ParsedAttachment = {
        kind: 'audio',
        fileKey,
        name,
        resourceMessageId: resource,
      }
      return single(attachment, `${noteOf(attachment)}${durationLabel(payload.duration)}`)
    }
    case 'media': {
      const fileKey = str(payload.file_key)
      const name = str(payload.file_name)
      if (!fileKey || !name) return only('[视频]（缺少文件名或文件标识）')
      const cover = str(payload.image_key)
      const attachment: ParsedAttachment = {
        kind: 'media',
        fileKey,
        name,
        resourceMessageId: resource,
        ...(cover ? { coverImageKey: cover } : {}),
      }
      return single(attachment, `${noteOf(attachment)}${durationLabel(payload.duration)}`)
    }
    case 'folder':
      return only(`[文件夹] ${str(payload.file_name) || '未命名文件夹'}（飞书不支持下载）`)
    case 'sticker':
      return only('[表情包]')
    case 'merge_forward':
      return { text: '[合并转发]', attachments: [], detail: 'merge_forward' }
    case 'interactive':
      return { text: cardText(payload) || '[卡片]', attachments: [], detail: 'interactive' }
    case 'share_chat': {
      const chatId = str(payload.chat_id)
      return {
        text: `[群名片] ${chatId}`.trim(),
        attachments: [],
        detail: 'share_chat',
        ...(chatId ? { sharedId: chatId } : {}),
      }
    }
    case 'share_user': {
      const userId = str(payload.user_id)
      return {
        text: `[个人名片] ${userId}`.trim(),
        attachments: [],
        detail: 'share_user',
        ...(userId ? { sharedId: userId } : {}),
      }
    }
    case 'system':
      return only(render(str(payload.template), payload) || '[系统消息]')
    case 'hongbao':
      return only(str(payload.text) || '[红包]')
    case 'share_calendar_event':
    case 'calendar':
    case 'general_calendar': {
      const summary = str(payload.summary)
      const range = between(
        formatFeishuTime(payload.start_time),
        formatFeishuTime(payload.end_time),
      )
      return only(summary ? `[日程] ${summary}${range}` : '[日程]')
    }
    case 'location': {
      const name = str(payload.name)
      const lng = str(payload.longitude)
      const lat = str(payload.latitude)
      return only(`[位置] ${name || '未命名位置'}${lng && lat ? `（${lng},${lat}）` : ''}`)
    }
    case 'video_chat': {
      const topic = str(payload.topic)
      const start = formatFeishuTime(payload.start_time)
      return only(`[视频会议] ${topic}${start ? `（${start}）` : ''}`.trim())
    }
    case 'todo': {
      const due = formatFeishuTime(payload.due_time)
      return only(`[任务] ${todoTitle(payload) || '未命名任务'}${due ? `（截止 ${due}）` : ''}`)
    }
    case 'vote': {
      const options = Array.isArray(payload.options) ? payload.options.map(str).filter(Boolean) : []
      const topic = str(payload.topic) || '投票'
      return only(`[投票] ${topic}${options.length > 0 ? `：${options.join(' / ')}` : ''}`)
    }
    case '':
      return only('')
    default:
      return only(`[不支持的消息类型 ${type}]`)
  }
}

// —— 卡片 ——

function cardElements(elements: unknown): Json[] {
  const result: Json[] = []
  if (!Array.isArray(elements)) return result
  for (const group of elements)
    for (const item of Array.isArray(group) ? group : [group]) if (isObject(item)) result.push(item)
  return result
}

function elementText(item: Json, depth = 0): string {
  if (depth > 8) return ''
  const tag = str(item.tag)
  if (tag === 'markdown' || tag === 'lark_md' || tag === 'plain_text')
    return str(item.content) || str(item.text)
  if (tag === 'div') {
    const text = item.text
    if (isObject(text)) return str(text.content) || str(text.text)
    const fields = Array.isArray(item.fields)
      ? item.fields
          .map((field) => (isObject(field) && isObject(field.text) ? str(field.text.content) : ''))
          .filter(Boolean)
      : []
    return joinLines([str(text), ...fields])
  }
  if (tag === 'column_set' && Array.isArray(item.columns))
    return joinLines(
      item.columns.flatMap((column) =>
        isObject(column) ? cardElements(column.elements).map((x) => elementText(x, depth + 1)) : [],
      ),
    )
  if (['text', 'note', 'a', 'button', 'collapsible_panel', 'form'].includes(tag)) {
    const own = isObject(item.text) ? str(item.text.content) : str(item.text) || str(item.content)
    if (own) return own
    return joinLines(cardElements(item.elements).map((x) => elementText(x, depth + 1)))
  }
  return ''
}

/** 卡片 JSON（1.0 的 elements、2.0 的 body.elements，或事件里的简化结构）抽出标题和文字 */
export function cardText(raw: unknown): string {
  const payload = contentObject(raw)
  const parts: string[] = []
  const header = payload.header
  if (isObject(header)) {
    const title = header.title
    parts.push(isObject(title) ? str(title.content) : str(title))
  }
  parts.push(str(payload.title))
  const body = payload.body
  const elements = isObject(body) ? body.elements : payload.elements
  for (const item of cardElements(elements)) parts.push(elementText(item))
  return joinLines(parts)
}

// —— 合并转发 ——

export interface ForwardChild {
  messageId: string
  msgType: string
  content: unknown
  /** 子消息是卡片时回源取到的卡片文字 */
  cardText?: string
}

/** 合并转发回源后：逐条渲染子消息，附件挂在父消息上下载 */
export function expandForward(parentId: string, children: ForwardChild[]): ParsedContent {
  const own = children.filter((child) => child.messageId !== parentId)
  const kept = own.slice(0, FORWARD_CHILD_LIMIT)
  const lines: string[] = []
  const attachments: ParsedAttachment[] = []
  kept.forEach((child, index) => {
    const parsed = parseContent(child.msgType, child.content, {
      messageId: child.messageId,
      resourceMessageId: parentId,
    })
    let text = child.msgType === 'interactive' && child.cardText ? child.cardText : parsed.text
    if (child.msgType === 'merge_forward') text = '[嵌套的合并转发，飞书不支持再展开]'
    if (text) lines.push(`${index + 1}. ${text}`)
    attachments.push(...parsed.attachments)
  })
  if (lines.length === 0) return { text: '[合并转发]（飞书没有返回内容）', attachments }
  const more =
    own.length > kept.length ? [`（共 ${own.length} 条，只展开前 ${kept.length} 条）`] : []
  return { text: joinLines(['[合并转发]', ...lines, ...more]), attachments }
}
