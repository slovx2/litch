// 把一份 Claude Code 原生会话的记录（SDK 的 getSessionMessages 给的主线消息）画成协议里的回合和条目。
// 用在“列出本机的 Claude Code 会话”上（native-sessions.mts）：别处（命令行、Claude 桌面端）开的会话
// 第一次被打开时照这里画一遍，写进适配器的库，之后和适配器自己建的会话一样读。纯函数，不碰文件。
//
// 怎么切回合：人说的一句话开一个回合，到下一句人话之前的助手回复、工具调用和结果都算这个回合的。
// 不算人话的用户消息：只有工具结果的；只有系统提醒的；后台任务的结束通知（origin 是 task-notification）；
// 斜杠命令在本地的输出；“[Request interrupted by user]”（它把当前回合记成被打断）。
// 人话前面 Claude 桌面端拼进去的 <system-reminder> 块去掉，只留人写的那部分。
// 条目的标识由消息的 uuid 和块的位置拼成：同一份记录再画一遍，标识不变。
import { toolItemWithResult } from './server-helpers.mjs'
import { readImageView, toolUseItem } from './tool-items.mjs'
import type { TurnRecord, UserInput } from './types.mjs'

/** 记录里的一条消息：SDK 的 SessionMessage，加上它实际带着的时间和来源 */
export interface NativeMessage {
  type: string
  uuid: string
  message: unknown
  parent_tool_use_id?: string | null
  timestamp?: string
  origin?: { kind?: string } | null
}

export interface NativeHistory {
  turns: TurnRecord[]
  /** 每个回合在原生记录里的最后一条消息（回退、分叉要用，和适配器自己记的边界是同一种） */
  boundaries: Map<string, string>
}

/** 这些工具在实时回合里也不画成工具条目：提问、计划确认由界面问，结构化输出是最终回答，待办是计划卡片 */
const HIDDEN_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'StructuredOutput', 'TodoWrite'])
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const LOCAL_OUTPUT = /<(local-command-stdout|local-command-stderr|local-command-caveat)>/

type Block = Record<string, unknown>

const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | null)?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

const secondsOf = (stamp: string | undefined): number | null => {
  const ms = stamp ? Date.parse(stamp) : Number.NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * 一条用户消息里人写的话。斜杠命令画成命令本身（/model opus）；系统提醒去掉；
 * 本地命令的输出、只有提醒的、空的都是 null
 */
export function humanText(text: string): string | null {
  if (LOCAL_OUTPUT.test(text)) return null
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim()
    const name = command[1]?.trim() ?? ''
    return name ? (args ? `${name} ${args}` : name) : null
  }
  const left = text.replace(REMINDER, '').trim()
  return left ? left : null
}

/** 用户消息里的图片：原样带成 data URL（协议里的 image 输入） */
function imageInput(block: Block): UserInput | null {
  const source = block.source as Record<string, unknown> | undefined
  if (source?.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return { type: 'image', url: `data:${media};base64,${source.data}` } as UserInput
  }
  if (source?.type === 'url' && typeof source.url === 'string')
    return { type: 'image', url: source.url } as UserInput
  return null
}

export function projectNativeHistory(
  threadId: string,
  messages: readonly NativeMessage[],
  cwd: string,
  mcpServers: readonly string[] = [],
): NativeHistory {
  const turns: TurnRecord[] = []
  const boundaries = new Map<string, string>()
  let turn: TurnRecord | null = null
  /** 这个回合里还没收到结果的工具调用：tool_use_id → 条目在 items 里的位置 */
  let open = new Map<string, number>()

  const finish = (done: TurnRecord | null) => {
    if (!done) return
    // 回合里最后一段回答是最终回答，前面的是过程中的话
    let last = true
    for (let at = done.items.length - 1; at >= 0; at--) {
      const item = done.items[at]
      if (item?.type !== 'agentMessage') continue
      done.items[at] = { ...item, phase: last ? 'final_answer' : 'commentary' }
      last = false
    }
    // 没等到结果的工具调用：记录到这里就断了，当成失败
    for (const at of open.values()) {
      const item = done.items[at]
      if (item) done.items[at] = toolItemWithResult(item, '', true, null)
    }
    open = new Map()
    if (done.startedAt !== null && done.completedAt !== null)
      done.durationMs = Math.max(0, done.completedAt - done.startedAt) * 1000
    turns.push(done)
  }

  /** 开一个新回合。content 是人说的话；记录开头就是助手的回复时没有，回合里不放用户消息 */
  const begin = (message: NativeMessage, content: UserInput[] | null): TurnRecord => {
    finish(turn)
    const at = secondsOf(message.timestamp)
    return {
      id: message.uuid,
      threadId,
      status: 'completed',
      startedAt: at,
      completedAt: at,
      durationMs: null,
      items: content ? [{ type: 'userMessage', id: `${message.uuid}:user`, content }] : [],
      diff: '',
      error: null,
    }
  }

  for (const message of messages) {
    // 子代理的消息不在主线里画（它们在子代理自己的记录里）
    if (message.parent_tool_use_id) continue
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const blocks = blocksOf(message.message)

    if (message.type === 'user') {
      for (const block of blocks) {
        if (block.type !== 'tool_result' || !turn) continue
        const toolUseId = String(block.tool_use_id ?? '')
        const at = open.get(toolUseId)
        const item = at === undefined ? undefined : turn.items[at]
        if (at === undefined || !item) continue
        open.delete(toolUseId)
        turn.items[at] = toolItemWithResult(item, block.content, block.is_error === true, null)
        const image = readImageView(item, block.content, block.is_error === true, cwd)
        if (image) turn.items.push(image)
      }
      const texts = blocks
        .filter((block) => block.type === 'text')
        .map((block) => String(block.text ?? ''))
      // 不开新回合的用户消息也是这个回合在原生记录里的一部分，边界跟着往后挪
      const stay = () => {
        if (turn) boundaries.set(turn.id, message.uuid)
      }
      if (texts.length === 1 && INTERRUPTED.test(texts[0]?.trim() ?? '')) {
        if (turn) turn.status = 'interrupted'
        stay()
        continue
      }
      if (message.origin?.kind === 'task-notification') {
        stay()
        continue
      }
      const said = texts.map(humanText).filter((text): text is string => text !== null)
      const images = blocks
        .filter((block) => block.type === 'image')
        .map(imageInput)
        .filter((input): input is UserInput => input !== null)
      // 只有工具结果之类的：还在这个回合里
      if (said.length === 0 && images.length === 0) {
        stay()
        continue
      }
      const text: UserInput[] =
        said.length > 0 ? [{ type: 'text', text: said.join('\n\n'), text_elements: [] }] : []
      turn = begin(message, [...text, ...images])
      boundaries.set(turn.id, message.uuid)
      continue
    }

    // 助手的消息。记录开头就是助手（没有人话打头）的，单独成一个回合
    turn ??= begin(message, null)
    const current = turn
    blocks.forEach((block, index) => {
      const id = `${message.uuid}:${index}`
      if (block.type === 'text') {
        const text = String(block.text ?? '')
        if (text.trim())
          current.items.push({ type: 'agentMessage', id, text, phase: null, memoryCitation: null })
      } else if (block.type === 'thinking') {
        const text = String(block.thinking ?? '')
        if (text.trim()) current.items.push({ type: 'reasoning', id, summary: [text], content: [] })
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? '')
        const toolUseId = String(block.id ?? '')
        if (!toolUseId || HIDDEN_TOOLS.has(name)) return
        const input = (block.input as Record<string, unknown> | undefined) ?? {}
        open.set(toolUseId, current.items.length)
        const item = toolUseItem({ toolUseId, toolName: name, input }, cwd, mcpServers, id)
        // 实时回合里 Write 拿磁盘上现在的文件比出差异；读历史时磁盘上早就是后来的样子了，只给写进去的全文
        current.items.push(
          name === 'Write' && item.type === 'fileChange'
            ? {
                ...item,
                changes: [
                  {
                    path: String(input.file_path ?? input.path ?? 'unknown'),
                    kind: { type: 'add' },
                    diff: String(input.content ?? ''),
                  },
                ],
              }
            : item,
        )
      }
    })
    const at = secondsOf(message.timestamp)
    if (at !== null) current.completedAt = at
    boundaries.set(current.id, message.uuid)
  }
  finish(turn)
  return { turns, boundaries }
}
