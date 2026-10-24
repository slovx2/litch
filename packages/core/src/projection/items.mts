// 投影的第一步：协议条目 → 显示条目。纯函数，不碰连接，不碰状态。
// 各种 harness 的差异在这里消化掉，界面拿到的条目和 harness 无关。
// 对面的协议版本可能比我们的类型新，所以不认识的条目类型、缺的字段都有兜底，不抛错。
import {
  CLIENT_TOOL_NAMESPACE,
  type FileUpdateChange,
  parseSessionEvent,
  parseSessionMentions,
  SESSION_TOOL,
  SESSION_TOOL_LIMITS,
  type ThreadItem,
  type UserInput,
  type WebSearchAction,
} from '../../../protocol/src/index.mjs'
import type {
  FileChangeEntry,
  ItemStatus,
  ItemView,
  PeerView,
  ToolCallItem,
  ToolPart,
  UserMessageItem,
} from '../model.mjs'
import type {
  AgentRefView,
  AgentState,
  SessionEventView,
  SessionNoteView,
  SpawnedView,
  WrapUpSuggestionView,
  WrapUpView,
} from '../model-tree.mjs'
import { type Phrase, type PhraseKey, phrase } from '../phrase.mjs'
import { capDiff } from '../text/diff.mjs'
import { capOutput, utf8Length } from '../text/output-cap.mjs'
import { blob, capParts } from '../text/tool-cap.mjs'
import { projectQuestions } from './asks.mjs'

const baseName = (path: string): string => path.split(/[\\/]/).pop() || path

/** 内容直接写在地址里的图片。只有这种才交给界面显示，别的地址界面不去取 */
export const isInlineImage = (url: unknown): url is string =>
  typeof url === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(url)

/** 条目上的 litchPeer（peerMessages 扩展：用户消息上是发送方，SendMessage 的工具条目上是收件方）：对面写的，逐项核对 */
function peerOf(raw: unknown): PeerView | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { name, session, thread, mode } = raw as Record<string, unknown>
  return {
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    session: typeof session === 'string' && session ? session : null,
    ...(typeof thread === 'string' && thread ? { thread } : {}),
    bypass: mode === 'bypass',
  }
}

function userMessage(id: string, content: UserInput[], rawPeer?: unknown): UserMessageItem {
  const texts: string[] = []
  const attachments: UserMessageItem['attachments'] = []
  for (const part of content ?? []) {
    switch (part.type) {
      case 'text':
        texts.push(part.text)
        break
      case 'image':
        attachments.push(
          'url' in part && isInlineImage(part.url)
            ? { kind: 'image', label: null, url: part.url }
            : { kind: 'image', label: null },
        )
        break
      case 'localImage':
        attachments.push({ kind: 'image', label: baseName(part.path) })
        break
      case 'audio':
        attachments.push({ kind: 'audio', label: null })
        break
      case 'localAudio':
        attachments.push({ kind: 'audio', label: baseName(part.path) })
        break
      case 'skill':
        attachments.push({ kind: 'skill', label: part.name })
        break
      case 'mention':
        attachments.push({ kind: 'file', label: part.name })
        break
    }
  }
  const text = texts.join('\n')
  // 别的会话发来的：原文照登，不认注入（那是对方的话）
  const peer = peerOf(rawPeer)
  if (peer) return { id, kind: 'userMessage', text, attachments, peer }
  // 设备进程注入在开头的子会话回报、唤醒：认出来单放，剩下的才是用户自己说的话
  const { event, rest } = parseSessionEvent(text)
  if (!event) return withSessionMentions({ id, kind: 'userMessage', text, attachments })
  return withSessionMentions({
    id,
    kind: 'userMessage',
    text: rest,
    attachments,
    event: sessionEvent(event),
  })
}

/** 正文末尾是提到会话的那一段的：认出来单放（sessions），text 里去掉那一段 */
export function withSessionMentions(item: UserMessageItem): UserMessageItem {
  const found = parseSessionMentions(item.text)
  if (!found) return item
  return {
    ...item,
    text: found.rest,
    sessions: found.mentions.map(({ index, threadId, title, harness }) => ({
      index,
      threadId,
      title,
      harness,
    })),
  }
}

const NOTE_STATUS = new Set(['completed', 'failed', 'interrupted', 'needsUser'])

/** 注入文字里那段 JSON 是对面写的：逐项核对，不合的那一条不要 */
function sessionEvent(event: { kind: string; notes: unknown[] }): SessionEventView {
  const notes = event.notes.flatMap((note) => {
    const view = noteView(note)
    return view ? [view] : []
  })
  const kind = event.kind === 'wake' || event.kind === 'remind' ? event.kind : 'notes'
  return { kind, notes }
}

/** 一条回报（注入文字里的、会话对象上排着的）：对面写的，逐项核对。不合的是 null */
export function noteView(note: unknown): SessionNoteView | null {
  if (typeof note !== 'object' || note === null) return null
  const { threadId, title, status, excerpt, error } = note as Record<string, unknown>
  if (typeof threadId !== 'string' || typeof status !== 'string' || !NOTE_STATUS.has(status))
    return null
  return {
    threadId,
    title: typeof title === 'string' ? title : '',
    status: status as SessionNoteView['status'],
    excerpt: typeof excerpt === 'string' ? excerpt : '',
    ...(typeof error === 'string' && error ? { error } : {}),
  }
}

const AGENT_STATES = new Set<string>([
  'pendingInit',
  'running',
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
])

/** 子代理调用涉及的子线程：收到的那几个，加上状态表里另外报了的 */
function agentRefs(
  receivers: readonly string[] | null | undefined,
  states:
    | Record<string, { status?: string; message?: string | null } | undefined>
    | null
    | undefined,
): AgentRefView[] {
  const ids = [...(receivers ?? [])]
  for (const id of Object.keys(states ?? {})) if (!ids.includes(id)) ids.push(id)
  return ids
    .filter((id) => typeof id === 'string' && id.length > 0)
    .map((threadId) => {
      const state = states?.[threadId]
      return {
        threadId,
        state:
          state?.status && AGENT_STATES.has(state.status) ? (state.status as AgentState) : null,
        message: typeof state?.message === 'string' && state.message ? state.message : null,
      }
    })
}

const word = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/**
 * litch_sessions.start 的条目：参数里的标题、harness，结果里起出来的子会话号、提案号，offer 卡上用户的选择；
 * litch_sessions.hand_off 的条目：标题、剩下的计划，结果里起出来的分叉会话。
 * 别的调用（list、read……）是 null，照普通的工具调用画
 */
function spawnedOf(
  namespace: string | null | undefined,
  tool: string,
  args: unknown,
  output: readonly { type: string; text?: string }[] | null | undefined,
): SpawnedView | null {
  if (namespace !== CLIENT_TOOL_NAMESPACE.sessions) return null
  if (tool !== SESSION_TOOL.start && tool !== SESSION_TOOL.handOff) return null
  const given = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const result = resultJson(output)
  const title = typeof given.title === 'string' ? given.title : ''
  if (tool === SESSION_TOOL.handOff) {
    return {
      via: 'handOff',
      threadId: word(result?.thread_id),
      proposalId: null,
      choice: null,
      title,
      prompt: typeof given.remaining_plan === 'string' ? given.remaining_plan : '',
      background: '',
      harness: null,
      model: null,
      effort: null,
      cwd: null,
      kind: 'fork',
      asked: false,
    }
  }
  const choice = result?.choice
  return {
    via: given.initiation === 'offer' ? 'offer' : 'start',
    threadId: word(result?.thread_id),
    proposalId: word(result?.proposal_id),
    choice: choice === 'session' || choice === 'here' ? choice : null,
    title,
    prompt: typeof given.prompt === 'string' ? given.prompt : '',
    background:
      given.kind !== 'fork' && typeof given.background === 'string' ? given.background : '',
    harness: word(given.harness),
    model: word(given.model),
    effort: word(given.effort),
    cwd: word(given.cwd),
    kind: given.kind === 'fork' ? 'fork' : 'fresh',
    asked: given.initiation === 'user_asked',
  }
}

/** 工具结果里的那段 JSON（客户端工具的结果是一段 inputText）。失败的结果是一行说明，不是 JSON：null */
function resultJson(
  output: readonly { type: string; text?: string }[] | null | undefined,
): Record<string, unknown> | null {
  for (const part of output ?? []) {
    if (part.type !== 'inputText' || typeof part.text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(part.text)
      if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // 不是 JSON，看下一段
    }
  }
  return null
}

/**
 * litch_sessions.wrap_up 的条目：参数里的每条建议，按顺序对上结果里它成了哪张提案、或者为什么没收。
 * 结果按建议的顺序给；对不上（条数不一样、标题不一样）时按标题找还没用过的那一条。
 * 整个调用失败了（参数不对、设备进程不认这个工具）就一张都没收：每条都写成没收下，原因是失败结果里那句话。别的调用是 null
 */
function wrapUpOf(
  namespace: string | null | undefined,
  tool: string,
  args: unknown,
  output: readonly { type: string; text?: string }[] | null | undefined,
  failed: boolean,
): WrapUpView | null {
  if (namespace !== CLIENT_TOOL_NAMESPACE.sessions || tool !== SESSION_TOOL.wrapUp) return null
  const given = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const listed = Array.isArray(given.suggestions) ? given.suggestions : []
  const answered = resultJson(output)?.suggestions
  const results = (Array.isArray(answered) ? answered : []).map((entry) =>
    typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {},
  )
  const failure = failed
    ? (output ?? [])
        .map((part) =>
          part.type === 'inputText' && typeof part.text === 'string' ? part.text : '',
        )
        .join('\n')
        .trim()
    : null
  const used = new Set<number>()
  const resultFor = (index: number, title: string): Record<string, unknown> | null => {
    const same = results[index]
    if (same && !used.has(index) && (same.title === undefined || same.title === title)) {
      used.add(index)
      return same
    }
    const found = results.findIndex((entry, at) => !used.has(at) && entry.title === title)
    if (found < 0) return null
    used.add(found)
    return results[found] ?? null
  }
  const suggestions = listed.flatMap((entry, index): WrapUpSuggestionView[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const raw = entry as Record<string, unknown>
    const title = typeof raw.title === 'string' ? raw.title : ''
    const result = resultFor(index, title)
    return [
      {
        title,
        prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
        background: raw.kind !== 'fork' && typeof raw.background === 'string' ? raw.background : '',
        harness: word(raw.harness),
        model: word(raw.model),
        effort: word(raw.effort),
        cwd: word(raw.cwd),
        kind: raw.kind === 'fork' ? 'fork' : 'fresh',
        proposalId: failure === null ? word(result?.proposal_id) : null,
        refused:
          failure !== null
            ? failure
            : result && !word(result.proposal_id)
              ? (word(result.refused) ?? '')
              : null,
      },
    ]
  })
  // 留给用户定的那件事和回复按钮：没有问题时按钮不画；按钮至多 wrapUpActions 个，没有字的不要
  const ask = typeof given.ask === 'string' ? given.ask.trim() : ''
  const actions = (Array.isArray(given.actions) ? given.actions : [])
    .flatMap((entry): { label: string; message?: string }[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const raw = entry as Record<string, unknown>
      const label = typeof raw.label === 'string' ? raw.label.trim() : ''
      const message = typeof raw.message === 'string' ? raw.message.trim() : ''
      return label ? [message ? { label, message } : { label }] : []
    })
    .slice(0, SESSION_TOOL_LIMITS.wrapUpActions)
  return {
    suggestions,
    ...(ask ? { ask } : {}),
    ...(ask && actions.length > 0 ? { actions } : {}),
  }
}

/** 数一个补丁里加了几行、删了几行。只认以单个加号或减号开头的行，文件头不算 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}

/** 一段文本有几行。末尾的换行不多算一行 */
const lineCount = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

export function projectFileChange(change: FileUpdateChange): FileChangeEntry {
  const diff = change.diff ?? ''
  const kind = change.kind?.type ?? 'update'
  // 新增和删除的文件，协议里给的往往不是补丁而是文件的全部内容
  const whole = kind !== 'update' && !/^@@ /m.test(diff)
  const lines = whole ? lineCount(diff) : 0
  const diffKind = whole ? 'content' : 'patch'
  return {
    path: change.path,
    change: kind,
    movedTo: change.kind?.type === 'update' ? (change.kind.move_path ?? null) : null,
    // 增删的行数按全文数，再截
    ...(whole
      ? { added: kind === 'add' ? lines : 0, removed: kind === 'delete' ? lines : 0 }
      : countDiffLines(diff)),
    ...capDiff(diff, diffKind),
    diffKind,
  }
}

/** 把任意 JSON 值排成给人看的文本。字符串原样给，别的缩进两格 */
export function showJson(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** base64 写的内容解出来有多少字节（不逐字解，按长度算） */
const base64Bytes = (data: string): number => {
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad)
}

/**
 * 动态工具（客户端工具：浏览器、Computer Use 的截图）结果里的图片，一个条目至多给几张留着内容，界面画成缩略图、
 * 点开看大图；再多的、太大的、不是常见格式的只留一行说明（和别的工具结果一样）。
 * 留着的内容在核心和界面的副本里各有一份、快照里也带着，所以要有上限：一个条目至多 IMAGE_KEEP 张，
 * 每张的 data: 地址至多 IMAGE_CHARS 个字（截图的大小由执行器自己压）。
 * 只看这一份结果，三条路（实时、读历史、恢复会话）一样
 */
export const IMAGE_KEEP = 4
export const IMAGE_CHARS = 4 * 1024 * 1024
const SHOWN_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]*$/

/**
 * 一个地址指着的图片、音频：内联的（data URL）记格式和大小，别的地址只记地址，界面不去取。
 * shown 为真时（动态工具的结果），能直接显示的图片把地址留在 src 上（之后由 keepImages 只留头几张）
 */
function addressed(type: 'image' | 'audio', url: unknown, shown = false): ToolPart {
  if (typeof url !== 'string') return blob(type)
  const inline = url.match(/^data:([^;,]*)((?:;[^;,]*)*),/)
  if (!inline) return blob(type, { name: url })
  const payload = url.length - inline[0].length
  const base64 = inline[2]?.split(';').includes('base64') === true
  const part = blob(type, {
    mime: inline[1] || null,
    bytes: base64 ? base64Bytes(url.slice(inline[0].length)) : payload,
  })
  if (shown && type === 'image' && url.length <= IMAGE_CHARS && SHOWN_IMAGE.test(url)) {
    return { ...part, src: url }
  }
  return part
}

/** 截过之后，只有头 IMAGE_KEEP 张图片留着内容，后面的去掉 src（只留一行说明） */
function keepImages(parts: ToolPart[]): ToolPart[] {
  let kept = 0
  let changed = false
  const next = parts.map((part) => {
    if (part.kind !== 'blob' || part.src === undefined) return part
    if (kept < IMAGE_KEEP) {
      kept++
      return part
    }
    changed = true
    const { src: _dropped, ...rest } = part
    return rest
  })
  return changed ? next : parts
}

const stringOr = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * 工具结果里的一段 → 显示的一段。MCP 的内容块、动态工具的 contentItems、函数工具的输出各是一种写法，都认。
 * 文字原样；图片、音频、资源只留种类、格式、大小和名字（照上游 TUI：内容不留，只写一行说明）；
 * 认不出的段排成 JSON（也照上游 TUI）。太长的由 capParts 统一截
 */
function resultPart(block: unknown, images = false): ToolPart {
  if (typeof block === 'string') return { kind: 'text', text: block }
  if (typeof block !== 'object' || block === null) return { kind: 'text', text: showJson(block) }
  const entry = block as Record<string, unknown>
  switch (entry.type) {
    // MCP 的图片、音频：data 是 base64
    case 'image':
    case 'audio':
      if (typeof entry.data === 'string') {
        return blob(entry.type, {
          mime: stringOr(entry.mimeType),
          bytes: base64Bytes(entry.data),
        })
      }
      break
    // 动态工具、函数工具的图片和音频是地址
    case 'inputImage':
      return addressed('image', entry.imageUrl, images)
    case 'inputAudio':
      return addressed('audio', entry.audioUrl)
    case 'input_image':
      return typeof entry.image_url === 'string'
        ? addressed('image', entry.image_url)
        : blob('image', { name: stringOr(entry.file_id) })
    case 'input_audio':
      return addressed('audio', entry.audio_url)
    // MCP 内嵌的资源：文字或 base64 的内容，按地址说
    case 'resource': {
      const resource = entry.resource as Record<string, unknown> | null | undefined
      if (typeof resource === 'object' && resource !== null) {
        const text = stringOr(resource.text)
        const data = stringOr(resource.blob)
        return blob('resource', {
          mime: stringOr(resource.mimeType),
          bytes: text !== null ? utf8Length(text) : data !== null ? base64Bytes(data) : null,
          name: stringOr(resource.uri),
        })
      }
      break
    }
    // MCP 的资源链接：只有地址
    case 'resource_link':
      return blob('link', {
        mime: stringOr(entry.mimeType),
        bytes: typeof entry.size === 'number' ? entry.size : null,
        name: stringOr(entry.uri) ?? stringOr(entry.name),
      })
    case 'encrypted_content':
      return blob('other', {
        bytes: typeof entry.encrypted_content === 'string' ? entry.encrypted_content.length : null,
        name: 'encrypted_content',
      })
  }
  // 带文字的一律当文字（各种写法的文字段都在这里：text、inputText、input_text）
  if (typeof entry.text === 'string') return { kind: 'text', text: entry.text }
  return { kind: 'text', text: JSON.stringify(block) }
}

/** 一段给人看的文本当作参数或结果：空的没有段，太长的截 */
const textParts = (text: string): ToolPart[] => capParts(text ? [{ kind: 'text', text }] : [])

/** 工具结果的各段，截过。一段文字都没有时补上结构化的结果（MCP 的 structuredContent） */
function resultParts(
  blocks: readonly unknown[] | null | undefined,
  structured?: unknown,
  images = false,
): ToolPart[] {
  const parts = (blocks ?? []).map((block) => resultPart(block, images))
  if (structured != null && !parts.some((part) => part.kind === 'text')) {
    parts.push({ kind: 'text', text: showJson(structured) })
  }
  const capped = capParts(parts)
  return images ? keepImages(capped) : capped
}

function searchQuery(query: string, action: WebSearchAction | null): string {
  if (query) return query
  if (!action) return ''
  if (action.type === 'search') return action.query ?? action.queries?.join('、') ?? ''
  if (action.type === 'openPage') return action.url ?? ''
  if (action.type === 'findInPage') return [action.pattern, action.url].filter(Boolean).join(' · ')
  return ''
}

const COLLAB_TOOL: Record<string, PhraseKey> = {
  spawnAgent: 'collab.spawnAgent',
  sendInput: 'collab.sendInput',
  resumeAgent: 'collab.resumeAgent',
  wait: 'collab.wait',
  closeAgent: 'collab.closeAgent',
  sendMessage: 'collab.sendMessage',
  followupTask: 'collab.followupTask',
  interruptAgent: 'collab.interruptAgent',
  listAgents: 'collab.listAgents',
}

const collabTool = (tool: string): Phrase | string => {
  const key = COLLAB_TOOL[tool]
  return key ? phrase(key) : tool
}

const toolStatus = (status: string): ItemStatus =>
  status === 'inProgress' ? 'inProgress' : status === 'failed' ? 'failed' : 'completed'

function toolCall(
  id: string,
  fields: Partial<ToolCallItem> & { tool: ToolCallItem['tool'] },
): ToolCallItem {
  return {
    id,
    kind: 'toolCall',
    source: null,
    input: [],
    output: [],
    error: null,
    durationMs: null,
    status: 'completed',
    ...fields,
  }
}

/**
 * 回合结束时还标着 inProgress 的条目，按回合的结局收尾（对面漏发了“完成”，不能一直显示在跑）。
 * 回合正常结束算完成，打断或失败算失败；上下文压缩一律算没完成。命令不管：后台命令跨回合跑，结束时对面再补完成；
 * 派子代理的调用也不管：子代理可能还在跑，它的状态以子线程为准。没什么要改的返回 null。
 */
export function settledItem(item: ItemView, turnCompleted: boolean): ItemView | null {
  if (!('status' in item) || item.status !== 'inProgress') return null
  // 压成了对面先发完成再结束回合（上游一直这样）；回合都结束了还没完成，就是没压成（Claude、Pi 自动压缩失败时回合照跑）
  if (item.kind === 'compaction') return { ...item, status: 'interrupted' }
  if (item.kind === 'agentMessage' || item.kind === 'reasoning')
    return { ...item, status: 'completed' }
  if (item.kind === 'fileChange' || (item.kind === 'toolCall' && item.agents === undefined))
    return { ...item, status: turnCompleted ? 'completed' : 'failed' }
  return null
}

/**
 * 一个协议条目对应一个显示条目，标识不变。
 * streaming 表示这个条目所在的回合还在进行：助手消息和推理本身不带状态，要靠它判断。
 */
export function projectItem(item: ThreadItem, streaming = false): ItemView {
  const id = item.id
  const open: ItemStatus = streaming ? 'inProgress' : 'completed'
  switch (item.type) {
    case 'userMessage':
      return userMessage(id, item.content, (item as { litchPeer?: unknown }).litchPeer)
    case 'agentMessage': {
      // 题目标识用协议条目自己的标识：显示条目的标识可能是本机另起的
      const questions = projectQuestions(item.id, item.questions)
      return {
        id,
        kind: 'agentMessage',
        text: item.text ?? '',
        phase:
          item.phase === 'final_answer'
            ? 'final'
            : item.phase === 'commentary'
              ? 'commentary'
              : 'unknown',
        status: open,
        ...(item.delivery === 'async' ? { delivery: 'async' as const } : {}),
        ...(questions ? { questions } : {}),
      }
    }
    case 'reasoning': {
      const summary = (item.summary ?? []).join('\n\n')
      return {
        id,
        kind: 'reasoning',
        text: summary || (item.content ?? []).join('\n\n'),
        status: open,
      }
    }
    case 'plan':
      return { id, kind: 'plan', text: item.text ?? '' }
    case 'commandExecution':
      return {
        id,
        kind: 'command',
        command: item.command,
        cwd: item.cwd,
        // 读历史、恢复会话、条目完成时拿到的是整段：按和实时接时同一个规矩截（text/output-cap.mts）
        ...capOutput(item.aggregatedOutput ?? ''),
        exitCode: item.exitCode ?? null,
        durationMs: item.durationMs ?? null,
        startedAt: null,
        status: item.status,
      }
    case 'fileChange':
      return {
        id,
        kind: 'fileChange',
        changes: (item.changes ?? []).map(projectFileChange),
        status: item.status,
      }
    case 'mcpToolCall': {
      const peer = peerOf((item as { litchPeer?: unknown }).litchPeer)
      return toolCall(id, {
        ...(peer ? { peer } : {}),
        source: item.server,
        tool: item.tool,
        input: textParts(showJson(item.arguments)),
        output: item.result ? resultParts(item.result.content, item.result.structuredContent) : [],
        // 错误信息也可能很长（MCP 服务把整段堆栈、整份请求放进来）：和结果一样截
        error: item.error ? textParts(item.error.message ?? '') : null,
        durationMs: item.durationMs ?? null,
        status: toolStatus(item.status),
      })
    }
    case 'dynamicToolCall': {
      // 客户端工具的截图要看得见：头几张图片留着内容（keepImages）
      const output = resultParts(item.contentItems, null, true)
      const spawned = spawnedOf(item.namespace, item.tool, item.arguments, item.contentItems)
      const wrapUp = wrapUpOf(
        item.namespace,
        item.tool,
        item.arguments,
        item.contentItems,
        item.success === false,
      )
      return toolCall(id, {
        ...(spawned ? { spawned } : {}),
        ...(wrapUp ? { wrapUp } : {}),
        source: item.namespace ?? null,
        tool: item.tool,
        input: textParts(showJson(item.arguments)),
        output,
        // 失败的结果里带着原因（客户端工具的“设备设置里关着”之类）就照它说；只报了失败的是核心自己的一句话
        error:
          item.success === false
            ? output.some((part) => part.kind === 'text')
              ? output
              : phrase('tool.failed')
            : null,
        durationMs: item.durationMs ?? null,
        status: toolStatus(item.status),
      })
    }
    case 'functionCallOutput':
      return toolCall(id, {
        source: item.namespace ?? null,
        tool: item.name,
        output: typeof item.output === 'string' ? textParts(item.output) : resultParts(item.output),
      })
    case 'collabAgentToolCall':
      return toolCall(id, {
        source: phrase('collab.source'),
        tool: collabTool(item.tool),
        input: textParts(item.prompt ?? ''),
        status: toolStatus(item.status),
        // 涉及哪几个子线程、各自什么状态：界面据此画成能点开的卡片
        agents: agentRefs(item.receiverThreadIds, item.agentsStates),
      })
    case 'webSearch':
      return { id, kind: 'webSearch', query: searchQuery(item.query, item.action) }
    case 'hookPrompt':
      return {
        id,
        kind: 'notice',
        label: phrase('notice.hookPrompt'),
        detail: (item.fragments ?? []).map((fragment) => fragment.text).join('\n') || null,
      }
    case 'subAgentActivity':
      return {
        id,
        kind: 'notice',
        label: phrase('notice.subAgentActivity'),
        detail: item.agentPath || null,
      }
    case 'imageView':
      return { id, kind: 'notice', label: phrase('notice.imageView'), detail: item.path }
    case 'imageGeneration':
      return {
        id,
        kind: 'notice',
        label: phrase('notice.imageGeneration'),
        detail: item.revisedPrompt ?? null,
      }
    case 'sleep':
      return {
        id,
        kind: 'notice',
        label: phrase('notice.slept', { seconds: Math.round(item.durationMs / 1000) }),
        detail: null,
      }
    case 'enteredReviewMode':
      return {
        id,
        kind: 'notice',
        label: phrase('notice.enteredReview'),
        detail: item.review || null,
      }
    case 'exitedReviewMode':
      return {
        id,
        kind: 'notice',
        label: phrase('notice.exitedReview'),
        detail: item.review || null,
      }
    case 'contextCompaction':
      // 是不是手动的由调用方按它知道的补上（live.mts、session.mts）
      return {
        id,
        kind: 'compaction',
        status: streaming ? 'inProgress' : 'completed',
        source: 'automatic',
      }
    default: {
      // 类型上这里到不了，但对面的协议可能比我们新
      const unknown = item as { id?: unknown; type?: unknown }
      return {
        id: typeof unknown.id === 'string' ? unknown.id : '',
        kind: 'notice',
        label: phrase('notice.unknownItem', { type: String(unknown.type) }),
        detail: null,
      }
    }
  }
}
